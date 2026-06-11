import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  appendControlUiTokenFragment,
  redactControlUiSmokeSecrets,
} from "./control-ui-smoke-url.js";

type GatewayInstance = {
  port: number;
  url: string;
  token: string;
  artifactDir: string;
  stateDir: string;
  configPath: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  stop: () => Promise<void>;
};

type ProjectSmokeSnapshot = {
  phase: string;
  active: number;
  archived: number;
  selectedId: string | null;
  projectName: string | null;
  resources: number;
  bodyText: string;
};

type ProjectSmokeSummary = {
  ok: true;
  url: string;
  authUrlClean: boolean;
  artifactDir: string;
  stateDir: string;
  projectName: string;
  snapshots: ProjectSmokeSnapshot[];
  selectors: {
    createFields: boolean;
    addNoteButton: boolean;
    archiveButton: boolean;
    restoreButton: boolean;
  };
  store: {
    total: number;
    active: number;
    archived: number;
  };
  consoleErrors: string[];
  responseErrors: string[];
  pageErrors: string[];
};

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactSmokeSecrets(value: string): string {
  return redactControlUiSmokeSecrets(value);
}

function localChromeCandidates(): string[] {
  if (platform() === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (platform() === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ];
}

function resolveBrowserExecutable(): string | undefined {
  const explicit = process.env.OPENCLAW_CONTROL_UI_SMOKE_BROWSER?.trim();
  if (explicit) {
    return explicit;
  }
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) {
    return bundled;
  }
  return localChromeCandidates().find((candidate) => existsSync(candidate));
}

function resolveGatewayEntrypoint(): string {
  if (existsSync("dist/index.js")) {
    return "dist/index.js";
  }
  if (existsSync("dist/index.mjs")) {
    return "dist/index.mjs";
  }
  return "scripts/run-node.mjs";
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve an ephemeral loopback port");
  }
  return address.port;
}

async function waitForPortOpen(params: {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stdout: string[];
  stderr: string[];
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (params.child.exitCode !== null) {
      throw new Error(
        `Gateway exited before listening (code=${String(params.child.exitCode)}):\n${formatLogs(
          params.stdout,
          params.stderr,
        )}`,
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: params.port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(
    `Timed out waiting for isolated Gateway on ${params.port}:\n${formatLogs(
      params.stdout,
      params.stderr,
    )}`,
  );
}

function formatLogs(stdout: string[], stderr: string[]): string {
  return `--- stdout ---\n${redactSmokeSecrets(stdout.join(""))}\n--- stderr ---\n${redactSmokeSecrets(
    stderr.join(""),
  )}`;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  return await Promise.race([
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      child.once("exit", () => resolve(true));
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function startIsolatedGateway(artifactDir: string): Promise<GatewayInstance> {
  const port = await getFreePort();
  const token = `projects-smoke-${randomUUID()}`;
  const homeDir = join(artifactDir, "home");
  const stateDir = join(homeDir, ".openclaw");
  const configPath = join(stateDir, "openclaw.json");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        gateway: {
          port,
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: true },
        },
        hooks: { enabled: false },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const entrypoint = resolveGatewayEntrypoint();
  const child = spawn(
    "node",
    [entrypoint, "gateway", "--port", String(port), "--bind", "loopback", "--allow-unconfigured"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_GATEWAY_TOKEN: "",
        OPENCLAW_GATEWAY_PASSWORD: "",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  await waitForPortOpen({ child, port, stdout, stderr, timeoutMs: 90_000 });

  return {
    port,
    url: `http://127.0.0.1:${port}/projects`,
    token,
    artifactDir,
    stateDir,
    configPath,
    child,
    stdout,
    stderr,
    stop: async () => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
      const stopped = await waitForExit(child, 2_000);
      if (!stopped && child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
        await waitForExit(child, 2_000);
      }
    },
  };
}

async function waitForProjectsTab(page: Page) {
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { connected?: boolean; tab?: string })
        | null;
      return app?.connected === true && app.tab === "projects";
    },
    null,
    { timeout: 45_000 },
  );
}

async function snapshotProjects(page: Page, phase: string): Promise<ProjectSmokeSnapshot> {
  return await page.evaluate((phaseName) => {
    type Project = { archived?: boolean; id?: string; name?: string; resources?: unknown[] };
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & {
          projectsList?: { projects?: Project[] } | null;
          projectsSelectedId?: string | null;
          projectsDetail?: { project?: Project } | null;
          projectsError?: string | null;
        })
      | null;
    const projects = app?.projectsList?.projects ?? [];
    const activeProjects = projects.filter((project) => project.archived !== true);
    const archivedProjects = projects.filter((project) => project.archived === true);
    const selectedProject = app?.projectsDetail?.project ?? activeProjects[0] ?? null;
    return {
      phase: phaseName,
      active: activeProjects.length,
      archived: archivedProjects.length,
      selectedId: app?.projectsSelectedId ?? null,
      projectName: selectedProject?.name ?? null,
      resources: selectedProject?.resources?.length ?? 0,
      bodyText: (document.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1600),
    } satisfies ProjectSmokeSnapshot;
  }, phase);
}

async function waitForProjectCounts(
  page: Page,
  counts: { active: number; archived: number; resources?: number },
  timeout = 30_000,
) {
  await page.waitForFunction(
    (expected) => {
      type Project = { archived?: boolean; resources?: unknown[] };
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { projectsList?: { projects?: Project[] } | null })
        | null;
      const projects = app?.projectsList?.projects ?? [];
      const activeProjects = projects.filter((project) => project.archived !== true);
      const archivedProjects = projects.filter((project) => project.archived === true);
      const detailProject = (
        app as (HTMLElement & { projectsDetail?: { project?: Project } | null }) | null
      )?.projectsDetail?.project;
      const resourceCount = detailProject
        ? Array.isArray(detailProject.resources)
          ? detailProject.resources.length
          : 0
        : activeProjects.reduce(
            (sum, project) =>
              sum + (Array.isArray(project.resources) ? project.resources.length : 0),
            0,
          );
      return (
        activeProjects.length === expected.active &&
        archivedProjects.length === expected.archived &&
        (expected.resources === undefined || resourceCount === expected.resources)
      );
    },
    counts,
    { timeout },
  );
}

async function assertNoProjectsError(page: Page, phase: string) {
  const diagnostics = await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & { projectsError?: string | null; connected?: boolean; tab?: string })
      | null;
    return {
      connected: app?.connected ?? null,
      tab: app?.tab ?? null,
      projectsError: app?.projectsError ?? null,
      bodyText: (document.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1600),
    };
  });
  const text = `${diagnostics.projectsError ?? ""} ${diagnostics.bodyText}`;
  if (/error loading|failed|project not found|unauthorized|forbidden/i.test(text)) {
    throw new Error(`Projects smoke saw an error during ${phase}: ${JSON.stringify(diagnostics)}`);
  }
}

async function readStoreCounts(stateDir: string): Promise<ProjectSmokeSummary["store"]> {
  const storePath = join(stateDir, "projects", "projects.json");
  const raw = await fs.readFile(storePath, "utf8");
  const parsed = JSON.parse(raw) as { projects?: Array<{ archived?: boolean }> };
  const projects = parsed.projects ?? [];
  return {
    total: projects.length,
    active: projects.filter((project) => project.archived !== true).length,
    archived: projects.filter((project) => project.archived === true).length,
  };
}

async function runProjectsFlow(page: Page, artifactDir: string, projectName: string) {
  const snapshots: ProjectSmokeSnapshot[] = [];
  await waitForProjectsTab(page);
  await page.getByPlaceholder("Project name").waitFor({ timeout: 45_000 });
  await assertNoProjectsError(page, "initial load");
  snapshots.push(await snapshotProjects(page, "initial"));
  await page.screenshot({ path: join(artifactDir, "01-initial.png"), fullPage: false });

  const selectors = {
    createFields:
      (await page.getByPlaceholder("Project name").count()) > 0 &&
      (await page.getByPlaceholder("Purpose").count()) > 0 &&
      (await page.getByPlaceholder("Project instructions").count()) > 0,
    addNoteButton: false,
    archiveButton: false,
    restoreButton: false,
  };
  if (!selectors.createFields) {
    throw new Error("Projects create fields were not visible.");
  }

  await page.getByPlaceholder("Project name").fill(projectName);
  await page.getByPlaceholder("Purpose").fill("Browser E2E archive and restore validation");
  await page
    .getByPlaceholder("Project instructions")
    .fill("Keep this isolated smoke project active unless the UI Archive action is used.");
  await page.getByRole("button", { name: "Create Project", exact: true }).click();
  await waitForProjectCounts(page, { active: 1, archived: 0 });
  await page.locator(".project-cockpit h2").filter({ hasText: projectName }).waitFor({
    timeout: 15_000,
  });
  await assertNoProjectsError(page, "created project");
  snapshots.push(await snapshotProjects(page, "created"));
  await page.screenshot({ path: join(artifactDir, "02-created.png"), fullPage: false });

  selectors.addNoteButton = (await page.getByRole("button", { name: "Add Note" }).count()) > 0;
  if (!selectors.addNoteButton) {
    throw new Error("Add Note action was not visible after project creation.");
  }
  await page.getByPlaceholder("Optional resource name").fill("Smoke Note");
  await page
    .getByPlaceholder("Quick note for this project")
    .fill("Project dashboard smoke resource content.");
  await page.getByRole("button", { name: "Add Note", exact: true }).click();
  await waitForProjectCounts(page, { active: 1, archived: 0, resources: 1 });
  await page.waitForFunction(
    () => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & {
            projectsDetail?: { project?: { resources?: Array<{ name?: string }> } } | null;
          })
        | null;
      return app?.projectsDetail?.project?.resources?.some((resource) =>
        resource.name?.includes("Smoke Note"),
      );
    },
    null,
    { timeout: 15_000 },
  );
  await assertNoProjectsError(page, "added resource note");
  snapshots.push(await snapshotProjects(page, "resource-added"));
  await page.screenshot({ path: join(artifactDir, "03-resource-added.png"), fullPage: false });

  selectors.archiveButton =
    (await page.getByRole("button", { name: "Archive", exact: true }).count()) > 0;
  if (!selectors.archiveButton) {
    throw new Error("Archive action was not visible for the active project.");
  }
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await waitForProjectCounts(page, { active: 0, archived: 1 });
  await page.getByText("Archived Projects", { exact: true }).waitFor({ timeout: 15_000 });
  await assertNoProjectsError(page, "archived project");
  snapshots.push(await snapshotProjects(page, "archived"));
  await page.screenshot({ path: join(artifactDir, "04-archived.png"), fullPage: false });

  selectors.restoreButton =
    (await page.getByRole("button", { name: "Restore", exact: true }).count()) > 0;
  if (!selectors.restoreButton) {
    throw new Error("Restore action was not visible for the archived project.");
  }
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await waitForProjectCounts(page, { active: 1, archived: 0, resources: 1 });
  await page.locator(".project-cockpit h2").filter({ hasText: projectName }).waitFor({
    timeout: 15_000,
  });
  await assertNoProjectsError(page, "restored project");
  snapshots.push(await snapshotProjects(page, "restored"));
  await page.screenshot({ path: join(artifactDir, "05-restored.png"), fullPage: false });

  return { snapshots, selectors };
}

async function main() {
  const artifactDir =
    process.env.OPENCLAW_CONTROL_UI_PROJECTS_ARTIFACT_DIR?.trim() ||
    join(".artifacts", "control-ui-projects", timestampSlug());
  mkdirSync(artifactDir, { recursive: true });

  const executablePath = resolveBrowserExecutable();
  if (!executablePath) {
    throw new Error(
      "No Playwright Chromium or local Chrome-compatible browser found. Install Playwright browsers or set OPENCLAW_CONTROL_UI_SMOKE_BROWSER.",
    );
  }

  let gateway: GatewayInstance | null = null;
  let browser: Browser | null = null;
  const consoleErrors: string[] = [];
  const responseErrors: string[] = [];
  const pageErrors: string[] = [];
  try {
    gateway = await startIsolatedGateway(artifactDir);
    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(
      (metadata) => {
        localStorage.setItem("openclaw.controlUi.clientMetadata", JSON.stringify(metadata));
      },
      {
        displayName: "OpenClaw Projects smoke desktop profile",
        deviceFamily: "control-ui-smoke",
        platform: "desktop",
      },
    );
    const page = await context.newPage();
    await page.addInitScript("globalThis.__name = (fn) => fn;");
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(redactSmokeSecrets(message.text()));
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 500) {
        responseErrors.push(`${response.status()} ${redactSmokeSecrets(response.url())}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(redactSmokeSecrets(error.message)));

    const launchUrl = appendControlUiTokenFragment(gateway.url, gateway.token);
    await page.goto(launchUrl, { waitUntil: "domcontentloaded" });
    const projectName = `Projects Smoke ${Date.now()}`;
    const { snapshots, selectors } = await runProjectsFlow(page, artifactDir, projectName);
    const authUrlClean = await page.evaluate(
      () => !/(?:[#?&])(?:token|password)=/i.test(window.location.href),
    );
    if (!authUrlClean) {
      throw new Error("Dashboard left auth material in the browser URL after bootstrap.");
    }
    if (consoleErrors.length > 0 || responseErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(
        `Projects smoke saw browser errors: ${JSON.stringify({
          consoleErrors,
          responseErrors,
          pageErrors,
        })}`,
      );
    }
    const store = await readStoreCounts(gateway.stateDir);
    if (store.total !== 1 || store.active !== 1 || store.archived !== 0) {
      throw new Error(`Projects store final state is wrong: ${JSON.stringify(store)}`);
    }

    const summary: ProjectSmokeSummary = {
      ok: true,
      url: gateway.url,
      authUrlClean,
      artifactDir,
      stateDir: gateway.stateDir,
      projectName,
      snapshots,
      selectors,
      store,
      consoleErrors,
      responseErrors,
      pageErrors,
    };
    writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`control-ui-projects-smoke: ok ${JSON.stringify(summary, null, 2)}`);
  } catch (error) {
    const logs = gateway ? `\nGateway logs:\n${formatLogs(gateway.stdout, gateway.stderr)}` : "";
    throw new Error(
      `${redactSmokeSecrets(error instanceof Error ? error.stack || error.message : String(error))}${logs}`,
      { cause: error },
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await gateway?.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    "control-ui-projects-smoke: failed",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
