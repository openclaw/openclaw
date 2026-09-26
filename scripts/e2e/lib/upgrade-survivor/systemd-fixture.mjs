// The direct survivor lane supports generated user units, not arbitrary systemd configuration.
// Inspection and launch share this parser so reported argv/environment cannot drift from execution.
import fs from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";

const unitName = "openclaw-gateway.service";
const unitPath = path.join(process.env.HOME, ".config/systemd/user", unitName);
// Native clients omit fixture-only env; loaded state must follow the inspected unit.
const loadedPath = `${unitPath}.loaded-unit`;
const manager = "org.freedesktop.systemd1";
const root = "/org/freedesktop/systemd1";
const object = `${root}/unit/openclaw_2dgateway_2eservice`;

function fail(message = "Unsupported survivor manager request or generated unit grammar.") {
  throw new Error(message);
}

function expandSpecifiers(value) {
  return value.replace(/%%|%h|%/g, (specifier) => {
    if (specifier === "%") {
      fail();
    }
    return specifier === "%h" ? process.env.HOME : "%";
  });
}

// buildSystemdUnit quotes whole words and escapes only quotes/backslashes.
function words(value) {
  const result = [];
  const pattern = /(?:"(?:[^"\\]|\\["\\])*"|[^\s"\\]+)(?:\s+|$)/gy;
  let offset = 0;
  while (offset < value.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(value);
    if (!match) {
      fail();
    }
    const word = match[0].trimEnd();
    result.push(word.startsWith('"') ? word.slice(1, -1).replace(/\\(["\\])/g, "$1") : word);
    offset = pattern.lastIndex;
  }
  return result.map(expandSpecifiers);
}

function assignments(values) {
  return Object.fromEntries(
    values.map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(0, separator))) {
        fail();
      }
      return [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
}

function parseUnit(content) {
  const directives = new Map();
  let section = "";
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    if (section !== "[Service]") {
      continue;
    }
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 0) {
      fail();
    }
    const values = directives.get(key) || [];
    values.push(line.slice(separator + 1));
    directives.set(key, values);
  }
  const single = (key) => {
    const values = directives.get(key) || [];
    if (values.length > 1) {
      fail();
    }
    return values[0] || "";
  };
  const programArguments = words(single("ExecStart"));
  if (!programArguments.length || !path.isAbsolute(programArguments[0])) {
    fail();
  }
  const expanded = expandSpecifiers(single("WorkingDirectory"));
  if (expanded && !path.isAbsolute(expanded)) {
    fail();
  }
  // Remove only the renderer's trailing /. shield; normalizing .. would change symlink traversal.
  const workingDirectory = expanded.endsWith("/.") ? expanded.slice(0, -2) || "/" : expanded;
  const environment = assignments(
    (directives.get("Environment") || []).flatMap((value) => {
      if (!value) {
        fail();
      }
      return words(value);
    }),
  );
  const environmentFiles = (directives.get("EnvironmentFile") || []).map((value) => {
    const optional = value.startsWith("-");
    const pattern = expandSpecifiers(optional ? value.slice(1) : value);
    if (!path.isAbsolute(pattern)) {
      fail();
    }
    // This copied, dependency-free shim accepts only the renderer's literal glob escapes.
    // Keep the expanded pattern for manager properties; reject unsupported wildcards at load.
    const filename = pattern.replace(
      /\\([?*()[\]\\])|[?*[\]\\]/g,
      (_match, literal) => literal ?? fail(),
    );
    return { pattern, filename, optional };
  });
  const supported = new Set([
    "ExecStart",
    "WorkingDirectory",
    "Environment",
    "EnvironmentFile",
    "Restart",
    "RestartSec",
    "RestartPreventExitStatus",
    "TimeoutStopSec",
    "TimeoutStartSec",
    "SuccessExitStatus",
    "OOMPolicy",
    "KillMode",
  ]);
  if ([...directives.keys()].some((key) => !supported.has(key))) {
    fail();
  }
  return {
    programArguments,
    workingDirectory,
    environment,
    environmentFiles,
    killMode: single("KillMode") || "control-group",
  };
}

function readUnit(reload = false, requireLoaded = false) {
  for (const directory of [`${unitPath}.d`, path.join(path.dirname(unitPath), "service.d")]) {
    if (fs.existsSync(directory) && fs.readdirSync(directory).length) {
      fail();
    }
  }
  let content;
  try {
    content = fs.readFileSync(unitPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    if (!requireLoaded) {
      fs.rmSync(loadedPath, { force: true });
    }
    return null;
  }
  parseUnit(content);
  if (requireLoaded && !fs.existsSync(loadedPath)) {
    fail(`Call failed: Unit ${unitName} not loaded.`);
  }
  // Keep the manager's loaded command until daemon-reload; file edits alone do not activate it.
  if (reload || !fs.existsSync(loadedPath)) {
    fs.writeFileSync(loadedPath, content);
  }
  const loaded = fs.readFileSync(loadedPath, "utf8");
  return { ...parseUnit(loaded), reloadPending: loaded !== content };
}

function runtimePaths() {
  const file = path.join(path.dirname(import.meta.filename), "systemd-fixture-runtime.json");
  const stat = fs.statSync(file);
  return { ...JSON.parse(fs.readFileSync(file, "utf8")), uid: stat.uid, owner: `:1.${stat.ino}` };
}

function livePid(value, processGroup = false) {
  if (value === 0) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
    fail();
  }
  try {
    process.kill(processGroup ? -value : value, 0);
    if (!processGroup && process.platform === "linux") {
      const state = fs.readFileSync(`/proc/${value}/stat`, "utf8").split(") ").at(-1);
      if (state.startsWith("Z ")) {
        return 0;
      }
    }
    return value;
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes(error.code)) {
      throw error;
    }
    return 0;
  }
}

function nativeRuntime() {
  const paths = runtimePaths();
  const readOptional = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };
  const last = readOptional(`${paths.daemonLog}.exit.json`)?.last;
  const counts = readOptional(`${paths.daemonLog}.runtime.json`);
  const pid = livePid(counts?.pid ?? 0);
  const supervisorPid = livePid(counts?.supervisorPid ?? 0);
  const groupPid = livePid(counts?.groupPid ?? 0, true);
  const unsettled = counts?.starting || supervisorPid || groupPid;
  const successful = !last || last.code === 0;
  return {
    pid,
    // A manager draining descendants or awaiting restart is not a settled service.
    active: pid ? "active" : unsettled ? "activating" : "inactive",
    sub: pid ? "running" : unsettled ? "auto-restart" : "dead",
    generation: counts?.entered ?? 0,
    settled: !pid && !unsettled,
    restarts: counts?.restarts ?? 0,
    result: successful ? "success" : "exit-code",
    exitStatus: Number.isInteger(last?.code) ? last.code : (osConstants.signals[last?.signal] ?? 0),
    exitCode: last ? (last.signal ? 2 : 1) : 0,
  };
}

function inspectLoadedRuntime(args) {
  const prefix = args.slice(0, 3);
  if (
    prefix[0] !== "--user" ||
    !prefix.includes("--auto-start=no") ||
    !prefix.includes("--json=short")
  ) {
    return false;
  }
  const request = args.slice(prefix.length);
  const matches = (expected) =>
    request.length === expected.length &&
    request.every((value, index) => value === expected[index]);
  const paths = runtimePaths();
  const bus = "org.freedesktop.DBus";
  if (matches(["call", bus, "/org/freedesktop/DBus", bus, "GetNameOwner", "s", manager])) {
    writeProperties([["s", [paths.owner]]]);
    return true;
  }
  if (
    matches(["call", bus, "/org/freedesktop/DBus", bus, "GetConnectionUnixUser", "s", paths.owner])
  ) {
    writeProperties([["u", [paths.uid]]]);
    return true;
  }
  if (request[1] !== paths.owner) {
    return false;
  }
  if (matches(["call", paths.owner, root, `${manager}.Manager`, "LoadUnit", "s", unitName])) {
    if (!readUnit()) {
      fail(`Call failed: Unit ${unitName} not found.`);
    }
    writeProperties([["o", [object]]]);
    return true;
  }
  // GetUnit observes already loaded state; unlike the legacy LoadUnit fixture
  // path it never creates a loaded definition or activates a process.
  if (!fs.existsSync(loadedPath)) {
    fail("Fixture unit is not already loaded.");
  }
  const unit = parseUnit(fs.readFileSync(loadedPath, "utf8"));
  if (!unit) {
    fail();
  }
  if (matches(["call", paths.owner, root, `${manager}.Manager`, "GetUnit", "s", unitName])) {
    writeProperties([["o", [object]]]);
    return true;
  }
  for (const scope of ["Unit", "Service"]) {
    if (
      matches([
        "get-property",
        paths.owner,
        object,
        `${manager}.${scope}`,
        ...commandPropertyNames(scope),
      ])
    ) {
      writeCommandProperties(readUnit(false, true), scope);
      return true;
    }
  }
  const runtime = nativeRuntime();
  if (
    matches([
      "get-property",
      paths.owner,
      object,
      `${manager}.Unit`,
      "Id",
      "LoadState",
      "ActiveState",
      "SubState",
      "StartLimitBurst",
      "ActiveEnterTimestampMonotonic",
      "InactiveEnterTimestampMonotonic",
    ])
  ) {
    writeProperties([
      ["s", unitName],
      ["s", "loaded"],
      ["s", runtime.active],
      ["s", runtime.sub],
      ["u", 5],
      ["t", runtime.pid ? runtime.generation : 0],
      ["t", runtime.pid ? 0 : runtime.generation],
    ]);
    return true;
  }
  const runtimeQuery = [
    "get-property",
    paths.owner,
    object,
    `${manager}.Service`,
    "Result",
    "NRestarts",
    "MainPID",
    "ExecMainStatus",
    "ExecMainCode",
    "KillMode",
    "TasksCurrent",
    "MemoryCurrent",
  ];
  const includeControlGroup = matches([...runtimeQuery, "ControlGroup"]);
  if (matches(runtimeQuery) || includeControlGroup) {
    // systemd's unavailable uint64 sentinel stays unknown to the native reader.
    const unknown = Number(0xffff_ffff_ffff_ffffn);
    writeProperties([
      ["s", runtime.result],
      ["u", runtime.restarts],
      ["u", runtime.pid],
      ["i", runtime.exitStatus],
      ["i", runtime.exitCode],
      ["s", unit.killMode],
      ["t", runtime.settled ? 0 : unknown],
      ["t", unknown],
      // This process-group emulator does not create a native systemd cgroup.
      ...(includeControlGroup ? [["s", ""]] : []),
    ]);
    return true;
  }
  return fail();
}

function writeProperties(properties) {
  for (const [type, data] of properties) {
    console.log(JSON.stringify({ type, data }));
  }
}

function commandPropertyNames(scope) {
  return scope === "Unit"
    ? ["FragmentPath", "DropInPaths", "NeedDaemonReload", "LoadState"]
    : ["ExecStart", "WorkingDirectory", "Environment", "EnvironmentFiles", "UnsetEnvironment"];
}

function writeCommandProperties(unit, scope) {
  if (!unit) {
    fail("Fixture unit is not loaded.");
  }
  writeProperties(
    scope === "Unit"
      ? [
          ["s", unitPath],
          ["as", []],
          ["b", unit.reloadPending],
          ["s", "loaded"],
        ]
      : [
          [
            "a(sasbttttuii)",
            [[unit.programArguments[0], unit.programArguments, false, 0, 0, 0, 0, 0, 0, 0]],
          ],
          ["s", unit.workingDirectory],
          ["as", Object.entries(unit.environment).map(([key, value]) => `${key}=${value}`)],
          ["a(sb)", unit.environmentFiles.map(({ pattern, optional }) => [pattern, optional])],
          ["as", []],
        ],
  );
}

function recordCaller(file, parentPid, action) {
  const roles = [];
  let pid = Number(parentPid);
  for (let depth = 0; depth < 64 && Number.isSafeInteger(pid) && pid > 1; depth++) {
    try {
      // Commander replaces argv[0] with these titles before executing the action.
      const title = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
      if (title === "openclaw-doctor" || title === "openclaw-update") {
        roles.push(title.slice("openclaw-".length));
      }
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") {
        throw error;
      }
      break;
    }
  }
  // Caller evidence contains roles only; never retain process arguments or environment values.
  fs.appendFileSync(file, `${JSON.stringify({ action, roles })}\n`);
}

function run() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "begin-start" && !args.length) {
    const file = `${runtimePaths().daemonLog}.runtime.json`;
    const claim = `${file}.start`;
    const descriptor = fs.openSync(claim, "wx");
    try {
      // Serialize the settled check and publication across concurrent start callers.
      if (!nativeRuntime().settled) {
        fail("Previous survivor service generation is not settled.");
      }
      // Keep launch custody visible before the detached supervisor publishes its child.
      // A failed launch remains unknown instead of authorizing offline restoration.
      fs.writeFileSync(`${file}.pending`, JSON.stringify({ starting: true }));
      fs.renameSync(`${file}.pending`, file);
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(claim);
    }
    return;
  }
  if (operation === "is-active" && !args.length) {
    const runtime = nativeRuntime();
    process.exitCode = runtime.pid ? 0 : runtime.settled ? 3 : 1;
    return;
  }
  if (operation === "runtime" && !args.length) {
    const runtime = nativeRuntime();
    console.log(`ActiveState=${runtime.active}\nSubState=${runtime.sub}\nMainPID=${runtime.pid}`);
    if (runtime.exitCode) {
      console.log(
        `ExecMainStatus=${runtime.exitStatus}\nExecMainCode=${runtime.exitCode === 1 ? "exited" : "killed"}`,
      );
    }
    return;
  }
  if (operation === "record-caller" && args.length === 3) {
    recordCaller(...args);
    return;
  }
  if (
    operation === "busctl" &&
    args.length === 7 &&
    args.join(" ") ===
      `--user --auto-start=no get-property ${manager} ${root} ${manager}.Manager Version`
  ) {
    console.log('s "252.39-1~deb12u2"');
    return;
  }
  if (operation === "busctl" && inspectLoadedRuntime(args)) {
    return;
  }
  if (operation === "reload" && !args.length) {
    readUnit(true);
    return;
  }
  if (operation === "load-state" && !args.length) {
    console.log(readUnit() ? "loaded" : "not-found");
    return;
  }
  if (operation === "command" && !args.length) {
    const unit = readUnit();
    if (!unit) {
      fail("Cannot launch an absent fixture unit.");
    }
    const environment = { ...unit.environment };
    for (const { filename, optional } of unit.environmentFiles) {
      let content;
      try {
        content = fs.readFileSync(filename, "utf8");
      } catch (error) {
        if (optional && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim() || line.startsWith("#")) {
          continue;
        }
        const separator = line.indexOf("=");
        if (separator <= 0) {
          fail();
        }
        const raw = line.slice(separator + 1);
        // serializeSystemdEnvironmentFile escapes exactly these four characters.
        const value =
          raw.startsWith('"') && raw.endsWith('"')
            ? raw.slice(1, -1).replace(/\\(["\\`$])/g, "$1")
            : raw;
        Object.assign(environment, assignments([`${line.slice(0, separator)}=${value}`]));
      }
    }
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [
      "env",
      ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      ...unit.programArguments,
    ];
    // Physical traversal matches chdir: shell-logical .. can select a different directory.
    console.log(
      `cd -P ${quote(unit.workingDirectory || process.env.HOME)} && exec ${command.map(quote).join(" ")}`,
    );
    return;
  }
  if (operation !== "busctl") {
    fail();
  }
  const matches = (expected) =>
    args.length === expected.length && args.every((arg, index) => arg === expected[index]);
  const requireLoaded = args[2] === "--auto-start=no";
  const prefix = ["--user", "--json=short", ...(requireLoaded ? ["--auto-start=no"] : [])];
  if (
    requireLoaded &&
    matches([
      ...prefix,
      "call",
      manager,
      root,
      `${manager}.Manager`,
      "GetUnitFileState",
      "s",
      unitName,
    ])
  ) {
    if (!fs.existsSync(unitPath)) {
      fail(`Call failed: Unit file ${unitName} does not exist.`);
    }
    writeProperties([["s", "disabled"]]);
    return;
  }
  const load = matches([
    ...prefix,
    "call",
    manager,
    root,
    `${manager}.Manager`,
    requireLoaded ? "GetUnit" : "LoadUnit",
    "s",
    unitName,
  ]);
  const unitQuery = matches([
    ...prefix,
    "get-property",
    manager,
    object,
    `${manager}.Unit`,
    ...commandPropertyNames("Unit"),
  ]);
  const serviceQuery = matches([
    ...prefix,
    "get-property",
    manager,
    object,
    `${manager}.Service`,
    ...commandPropertyNames("Service"),
  ]);
  if (!load && !unitQuery && !serviceQuery) {
    fail();
  }
  const unit = readUnit(false, requireLoaded);
  if (!unit) {
    if (load) {
      fail(`Call failed: Unit ${unitName} not found.`);
    }
    fail("Fixture unit is not loaded.");
  }
  if (load) {
    writeProperties([["o", [object]]]);
  } else {
    writeCommandProperties(unit, unitQuery ? "Unit" : "Service");
  }
}

try {
  run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
