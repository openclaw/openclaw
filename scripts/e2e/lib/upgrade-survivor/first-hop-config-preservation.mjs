// CLI-only assertions for the synthetic packaged-updater first-hop lane.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const [command, configArgument, artifactArgument, extra] = process.argv.slice(2);
const ROOT = "openclaw.json";
const PARENT = "first-hop-messages.json";
const LEAF = "first-hop-messages-leaf.json";
const MANUAL = `${ROOT}.bak.first-hop-manual`;
const BEFORE = "positive-config-before.json";
const AFTER_HOP = "positive-config-after-hop.json";
const CONVERGED = "positive-config-converged.json";
const ring = Array.from({ length: 5 }, (_, index) => `${ROOT}.bak${index ? `.${index}` : ""}`);
const references = {
  responsePrefix: "${UPGRADE_SURVIVOR_PREFIX}",
  usageTemplate: "$${UPGRADE_SURVIVOR_LITERAL}",
};
const variables = {
  UPGRADE_SURVIVOR_PREFIX: "first-hop-prefix",
  UPGRADE_SURVIVOR_LITERAL: "must-not-be-activated",
};

function requireProof(condition, label) {
  if (!condition) {
    throw new Error(label);
  }
}

function readFile(root, name) {
  const file = path.join(root, name);
  const stat = fs.lstatSync(file);
  requireProof(stat.isFile() && stat.nlink === 1, `not an owned regular file: ${name}`);
  return {
    raw: fs.readFileSync(file, "utf8"),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: stat.mode & 0o777,
  };
}

function readJson(root, name) {
  const { raw } = readFile(root, name);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON: ${name}`);
  }
}

function writeJson(root, name, value) {
  fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function capture(root) {
  // Never traverse operator state: only this lane's config, includes and their backups.
  const names = fs
    .readdirSync(root)
    .filter((name) =>
      [ROOT, PARENT, LEAF].some(
        (base) => name === base || name.startsWith(`${base}.bak`) || name === `${base}.pre-update`,
      ),
    );
  for (const required of [ROOT, PARENT, LEAF, MANUAL]) {
    requireProof(names.includes(required), `missing fixture file: ${required}`);
  }
  return Object.fromEntries(names.toSorted().map((name) => [name, readFile(root, name)]));
}

function sameFile(actual, expected, name) {
  requireProof(isDeepStrictEqual(actual, expected), `file changed: ${name}`);
}

function needsCanonicalRoster(config) {
  if (!Object.hasOwn(config, "agents")) {
    return true;
  }
  const agents = config.agents;
  return (
    agents &&
    typeof agents === "object" &&
    !Array.isArray(agents) &&
    !["entries", "list", "$include"].some((key) => Object.hasOwn(agents, key)) &&
    agents.ownership !== "explicit"
  );
}

function assertRoot(raw, before, targetVersion) {
  let actual;
  try {
    actual = JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON: ${ROOT}`);
  }
  const expected = JSON.parse(before.files[ROOT].raw);
  // legacy.roster.ts persists only this implicit roster; existing defaults remain authored.
  // Do not extend this exception to included, explicit or legacy rosters.
  if (needsCanonicalRoster(expected) && isDeepStrictEqual(actual.agents?.entries, { main: {} })) {
    expected.agents = { ...expected.agents, entries: { main: {} } };
  }
  // setup_lane's selected mock model triggers this one auto-enable transition.
  // Match materialize.registerPluginEntry without masking any other plugin fields.
  if (before.activateOpenai && actual.plugins?.entries?.openai?.enabled === true) {
    expected.plugins = {
      ...expected.plugins,
      entries: {
        ...expected.plugins?.entries,
        openai: { ...expected.plugins?.entries?.openai, enabled: true },
      },
    };
  }
  // Config writes stamp only this version field (config/io.meta.ts). Do not mask meta.
  if (actual.meta?.lastTouchedVersion !== expected.meta?.lastTouchedVersion) {
    requireProof(
      actual.meta?.lastTouchedVersion === targetVersion,
      "meta.lastTouchedVersion changed",
    );
    expected.meta.lastTouchedVersion = targetVersion;
  }
  // A real Doctor write stamps these five fields (commands/onboard-helpers.ts).
  // All other wizard fields and the entire remaining config must survive unchanged.
  if (!isDeepStrictEqual(actual.wizard, expected.wizard)) {
    const wizard = actual.wizard;
    const time = Date.parse(wizard?.lastRunAt);
    requireProof(
      wizard?.lastRunVersion === targetVersion &&
        wizard.lastRunCommand === "doctor" &&
        wizard.lastRunMode === "local" &&
        time >= before.capturedAt &&
        time <= Date.now() &&
        wizard.lastRunCommit === before.commit,
      "wizard provenance changed outside a Doctor write",
    );
    expected.wizard = {
      ...expected.wizard,
      lastRunAt: wizard.lastRunAt,
      lastRunVersion: targetVersion,
      lastRunCommand: "doctor",
      lastRunMode: "local",
    };
    if (before.commit) {
      expected.wizard.lastRunCommit = before.commit;
    } else {
      delete expected.wizard.lastRunCommit;
    }
  }
  requireProof(
    isDeepStrictEqual(actual, expected),
    "root config changed outside permitted metadata",
  );
  return actual;
}

function assertBackups(files, previous, before) {
  sameFile(files[MANUAL], before.files[MANUAL], MANUAL);
  requireProof(
    files[`${ROOT}.pre-update`]?.raw === before.files[ROOT].raw,
    "pre-update snapshot lost original root bytes",
  );
  // backup-rotation.ts renames surviving history and tightens its mode to 0600.
  // Without a surviving original, five writes and wholesale replacement are indistinguishable.
  const witnessed = ring.some((name) =>
    ring.some(
      (old) =>
        files[name] &&
        previous[old] &&
        files[name].dev === previous[old].dev &&
        files[name].ino === previous[old].ino &&
        files[name].raw === previous[old].raw,
    ),
  );
  requireProof(witnessed, "backup preservation proof inconclusive: no original history witness");
  const possible = ring.some((_, shift) =>
    ring.every((name, index) => {
      if (index >= shift) {
        const original = previous[ring[index - shift]];
        return isDeepStrictEqual(
          files[name],
          original && shift > 0 ? { ...original, mode: 0o600 } : original,
        );
      }
      if (!files[name] || files[name].mode !== 0o600) {
        return false;
      }
      // The oldest newly inserted backup is the exact root captured before this phase.
      if (index === shift - 1) {
        return files[name].raw === previous[ROOT].raw;
      }
      try {
        assertRoot(files[name].raw, before, before.targetVersion);
        return true;
      } catch {
        return false;
      }
    }),
  );
  requireProof(possible, "backup ring lost or rewrote recovery history");
  const fixedNames = Object.keys(previous).filter(
    (name) => name !== ROOT && name !== `${ROOT}.pre-update` && !ring.includes(name),
  );
  for (const name of fixedNames) {
    sameFile(files[name], previous[name], name);
  }
  requireProof(
    Object.keys(files).every(
      (name) =>
        name === ROOT ||
        name === `${ROOT}.pre-update` ||
        ring.includes(name) ||
        fixedNames.includes(name),
    ),
    "unexpected include or backup file",
  );
}

function assertHop(files, before) {
  const config = assertRoot(files[ROOT].raw, before, before.targetVersion);
  assertBackups(files, before.files, before);
  return config;
}

try {
  requireProof(
    ["seed", "assert-hop", "assert-repair", "assert-doctor"].includes(command) &&
      configArgument &&
      artifactArgument,
    "expected seed|assert-hop|assert-repair|assert-doctor CONFIG ARTIFACT_DIR [TARGET_VERSION]",
  );
  const root = fs.realpathSync(path.dirname(configArgument));
  const artifacts = fs.realpathSync(artifactArgument);
  requireProof(path.basename(configArgument) === ROOT, "unexpected config filename");
  if (command === "seed") {
    requireProof(
      extra && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(extra),
      "missing target version",
    );
    for (const name of [PARENT, LEAF, MANUAL]) {
      requireProof(!fs.existsSync(path.join(root, name)), `fixture collision: ${name}`);
    }
    requireProof(!fs.existsSync(path.join(artifacts, BEFORE)), "fixture snapshot already exists");
    const config = readJson(root, ROOT);
    requireProof(
      config?.gateway?.mode === "local" &&
        config.gateway.reload?.mode === "off" &&
        config.meta?.migrations?.modelPolicyAllowlist === true &&
        config.messages === undefined,
      "expected positive setup_lane config",
    );
    for (const name of Object.keys(variables)) {
      requireProof(
        config.env?.vars?.[name] === undefined && process.env[name] === undefined,
        `fixture env collision: ${name}`,
      );
    }
    config.env = { ...config.env, vars: { ...config.env?.vars, ...variables } };
    config.messages = { $include: `./${PARENT}` };
    writeJson(root, PARENT, { $include: `./${LEAF}` });
    writeJson(root, LEAF, references);
    fs.writeFileSync(configArgument, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.copyFileSync(configArgument, path.join(root, MANUAL), fs.constants.COPYFILE_EXCL);
    const model = config.agents?.defaults?.model;
    const modelRef = typeof model === "string" ? model : model?.primary;
    const activateOpenai =
      typeof modelRef === "string" &&
      modelRef.startsWith("openai/") &&
      config.models?.providers?.openai?.baseUrl === "http://127.0.0.1:44212/v1" &&
      config.plugins?.enabled !== false &&
      config.plugins?.entries?.openai?.enabled !== false &&
      config.plugins?.entries?.openai?.enabled !== true &&
      !config.plugins?.deny?.includes("openai") &&
      (!config.plugins?.allow?.length || config.plugins.allow.includes("openai"));
    writeJson(artifacts, BEFORE, {
      targetVersion: extra,
      capturedAt: Date.now(),
      commit: process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim() || undefined,
      activateOpenai,
      files: capture(root),
    });
  } else {
    const before = readJson(artifacts, BEFORE);
    const files = capture(root);
    if (command === "assert-hop") {
      // Retain rejected bytes too. An observation is not a passed preservation check.
      let observationError;
      try {
        writeJson(artifacts, AFTER_HOP, { kind: "after-hop-observation", files });
      } catch (error) {
        observationError = new Error("first-hop config preservation: input read/write failed", {
          cause: error,
        });
      }
      try {
        assertHop(files, before);
      } catch (error) {
        if (observationError) {
          console.error("after-hop observation could not be saved");
        }
        throw error;
      }
      if (observationError) {
        throw observationError;
      }
    } else {
      const phase = command === "assert-repair" ? "repair" : "fresh";
      const output = ["stdout", "stderr"]
        .map((suffix) => readFile(artifacts, `positive-${phase}-doctor.${suffix}`).raw)
        .join("\n");
      requireProof(output.includes("Doctor complete."), `${phase} Doctor did not complete`);
      requireProof(
        !/Skipping doctor config write|config fixes were not applied|No config changes were written|Invalid config:|Run[^\n]*doctor --fix/i.test(
          output,
        ),
        `${phase} Doctor skipped or refused config convergence`,
      );
      if (command === "assert-repair") {
        const afterHop = readJson(artifacts, AFTER_HOP);
        requireProof(afterHop.kind === "after-hop-observation", "missing after-hop observation");
        // Revalidate against the original before trusting this as the next backup baseline.
        const afterHopConfig = assertHop(afterHop.files, before);
        const config = assertRoot(files[ROOT].raw, before, before.targetVersion);
        assertBackups(files, afterHop.files, before);
        requireProof(
          !before.activateOpenai || config.plugins?.entries?.openai?.enabled === true,
          "required fixture OpenAI activation missing",
        );
        const rosterRequired = needsCanonicalRoster(JSON.parse(before.files[ROOT].raw));
        requireProof(
          !rosterRequired || isDeepStrictEqual(config.agents?.entries, { main: {} }),
          "required canonical agent roster missing",
        );
        // These phases identify observed transitions; Doctor/update logs own write attribution.
        writeJson(artifacts, CONVERGED, {
          files,
          activationPhase: before.activateOpenai
            ? afterHopConfig.plugins?.entries?.openai?.enabled === true
              ? "first-hop"
              : "first-repair"
            : "not-required",
          rosterPhase: rosterRequired
            ? isDeepStrictEqual(afterHopConfig.agents?.entries, { main: {} })
              ? "first-hop"
              : "first-repair"
            : "not-required",
        });
      } else {
        requireProof(
          isDeepStrictEqual(files, readJson(artifacts, CONVERGED).files),
          "fresh Doctor changed converged config or backup bytes/identity",
        );
      }
    }
  }
  console.log(`first-hop config preservation: ${command} passed`);
} catch (error) {
  // Do not expose JSON values or host paths from native I/O diagnostics.
  console.error(
    error instanceof Error && !("code" in error) && !(error instanceof SyntaxError)
      ? error.message
      : "first-hop config preservation: input read/write failed",
  );
  console.error("[first-hop-config-preservation] FAILED (exit 1)");
  process.exitCode = 1;
}
