import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readProductSpec } from "./app-builder.js";
import {
  applyAppStudioPrompt,
  applyAppStudioScreenAnalysis,
  buildAppStudioSnapshot,
  createAppStudioProject,
  importAppStudioAppleFacts,
  importAppStudioScreenImages,
  registerAppStudioGatewayMethods,
  reorderAppStudioScreens,
  runAppStudioGate,
  setAppStudioBuildEngine,
  updateAppStudioScreenFlow,
} from "./app-studio.js";

type AppsManifest = {
  activation?: {
    onStartup?: boolean;
  };
};

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-app-studio-test-"));
  tempDirs.push(dir);
  return dir;
}

function createApi() {
  const registerGatewayMethod = vi.fn();
  const api = { registerGatewayMethod } as unknown as OpenClawPluginApi;
  return { api, registerGatewayMethod };
}

function findHandler(
  registerGatewayMethod: ReturnType<typeof vi.fn>,
  method: string,
): GatewayHandler {
  const call = registerGatewayMethod.mock.calls.find((item) => item[0] === method);
  if (!call) {
    throw new Error(`missing handler for ${method}`);
  }
  return call[1] as GatewayHandler;
}

async function invoke(handler: GatewayHandler, params: Record<string, unknown>) {
  const box: {
    response?:
      | { ok: true; payload: unknown }
      | { ok: false; error: { code: string; message: string } };
  } = {};
  await handler({
    params,
    req: { type: "req", id: "test", method: "test" },
    client: null,
    context: {} as never,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      box.response = ok
        ? { ok: true, payload }
        : {
            ok: false,
            error: {
              code: error?.code ?? "error",
              message: error?.message ?? "unknown",
            },
          };
    },
  });
  if (!box.response) {
    throw new Error("handler did not respond");
  }
  return box.response;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("App Studio dashboard", () => {
  it("declares startup activation and registers gateway methods with operator scopes", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as AppsManifest;
    expect(manifest.activation?.onStartup).toBe(true);

    const { api, registerGatewayMethod } = createApi();
    registerAppStudioGatewayMethods(api);

    expect(registerGatewayMethod.mock.calls.map((call) => call[0])).toEqual([
      "apps.dashboard.snapshot",
      "apps.project.create",
      "apps.project.applyPrompt",
      "apps.project.setBuildEngine",
      "apps.project.reorderScreens",
      "apps.project.importScreenImages",
      "apps.project.applyScreenAnalysis",
      "apps.project.updateScreenFlow",
      "apps.project.importAppleFacts",
      "apps.project.runGate",
      "apps.project.approveGate",
    ]);
    expect(registerGatewayMethod.mock.calls[0][2]).toEqual({ scope: "operator.read" });
    expect(registerGatewayMethod.mock.calls[1][2]).toEqual({ scope: "operator.write" });
    expect(registerGatewayMethod.mock.calls.at(-1)?.[2]).toEqual({ scope: "operator.approvals" });
  });

  it("creates and discovers an App Studio project", async () => {
    const root = await makeTempDir();
    const result = await createAppStudioProject({
      cwd: root,
      request: "Create a private habit tracker for the Apple App Store",
      appName: "Habit Forge",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(result.snapshot.projects).toHaveLength(1);
    expect(result.snapshot.selectedProject?.appName).toBe("Habit Forge");
    expect(result.snapshot.selectedProject?.stage).toBe("blueprint");
    expect(result.snapshot.selectedProject?.activity.map((event) => event.summary)).toContain(
      "Created App Studio project dashboard state.",
    );
    expect(result.snapshot.selectedProject?.completionGrade).toBe(4);
    expect(result.snapshot.selectedProject?.criticality).toBe(10);
    expect(result.receipt.next).toContain("Check AI coder");

    const snapshot = await buildAppStudioSnapshot({ cwd: root });
    expect(snapshot.projects[0]?.bundleId).toContain("habit.forge");
  });

  it("applies prompts, updates visible screens, and creates the constrained builder task", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private notes app for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();

    const applied = await applyAppStudioPrompt({
      appDir: appDir!,
      prompt: "Add a weekly insights screen with no analytics or tracking.",
      now: new Date("2026-05-24T12:05:00.000Z"),
    });

    expect(applied.snapshot.selectedProject?.screens.map((screen) => screen.title)).toContain(
      "Weekly Insights",
    );
    expect(applied.snapshot.selectedProject?.spec.privacyPosture.tracking).toBe(false);
    const swift = await readFile(path.join(appDir!, "Sources", "AppModels.swift"), "utf8");
    expect(swift).toContain("Weekly Insights");
    const contentView = await readFile(path.join(appDir!, "Sources", "ContentView.swift"), "utf8");
    expect(contentView).toContain("Weekly Insights");
    expect(applied.snapshot.selectedProject?.latestReports.implementation).not.toBeNull();
    const task = await readFile(
      path.join(appDir!, ".openclaw-app-builder", "builder-task.md"),
      "utf8",
    );
    expect(task).toContain("Allowed Write Root");
  });

  it("lets the dashboard choose Codex as the app build engine", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private workout app for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();

    const selected = await setAppStudioBuildEngine({
      appDir: appDir!,
      buildEngine: "codex",
      now: new Date("2026-05-24T12:08:00.000Z"),
    });

    expect(selected.snapshot.buildEngineOptions.map((option) => option.id)).toContain("codex");
    expect(selected.snapshot.selectedProject?.studio.buildEngine).toBe("codex");
    expect(
      selected.snapshot.selectedProject?.studio.agentWorkboard.find((agent) => agent.id === "app-builder")
        ?.modelRef,
    ).toBe("openai/gpt-5.5");
    const task = await readFile(
      path.join(appDir!, ".openclaw-app-builder", "app-studio-agent-task.md"),
      "utf8",
    );
    expect(task).toContain("Build engine: Codex GPT-5.5");
    expect(task).toContain("use Codex for the code mutation/review loop");
  });

  it("runs the selected AI builder and applies its guarded app-local patch", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private birdwatching checklist app for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();
    let aiRequestModelRef = "";
    const completeText = vi.fn(async (request: { modelRef: string }) => {
      aiRequestModelRef = request.modelRef;
      return JSON.stringify(
        JSON.stringify({
          schemaVersion: 1,
          objective: "Make the generated app visibly birdwatching-specific.",
          changes: [
            {
              path: "README.md",
              action: "write",
              contents:
                "# Birdwatching Checklist\n\nAI build pass connected and customized this app for birdwatching.\n",
            },
          ],
          validation: { checkToolchain: false },
        }),
      );
    });

    const built = await runAppStudioGate({
      appDir: appDir!,
      gate: "builder-task",
      ai: { completeText },
      now: new Date("2026-05-24T12:15:00.000Z"),
    });

    expect(completeText).toHaveBeenCalledTimes(1);
    expect(aiRequestModelRef).toBe("ollama/qwen3.6:27b-q8_0");
    expect(built.receipt.detail).toContain("connected to AI");
    expect(built.snapshot.selectedProject?.latestReports.aiBuild).not.toBeNull();
    expect(built.snapshot.selectedProject?.latestReports.patch).not.toBeNull();
    expect(
      built.snapshot.selectedProject?.studio.agentWorkboard.find((agent) => agent.id === "app-builder")
        ?.status,
    ).toBe("done");
    const readme = await readFile(path.join(appDir!, "README.md"), "utf8");
    expect(readme).toContain("AI build pass connected");
  });

  it("recovers Qwen patch plans with escaped whitespace outside JSON strings", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private field notes app for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();

    const completeText = vi.fn(async () =>
      [
        "{",
        '  "schemaVersion": 1,',
        '  "objective": "Make README specific even when Qwen leaks escaped whitespace.",',
        '  "changes": [',
        "    {",
        '      "path": "README.md",',
        '      "action": "write",',
        '      "contents": "# Field Notes\\n\\nRecovered escaped whitespace outside JSON strings.\\n"',
        "    }",
        "  ],",
        '  "validation": {',
        '    "checkToolchain": false',
        "  }\\n",
        "}",
      ].join("\n"),
    );

    const built = await runAppStudioGate({
      appDir: appDir!,
      gate: "builder-task",
      ai: { completeText },
      now: new Date("2026-05-24T12:16:00.000Z"),
    });

    expect(completeText).toHaveBeenCalledTimes(1);
    expect(built.snapshot.selectedProject?.latestReports.aiBuild).not.toBeNull();
    expect(built.snapshot.selectedProject?.latestReports.patch).not.toBeNull();
    expect(
      built.snapshot.selectedProject?.studio.agentWorkboard.find((agent) => agent.id === "app-builder")
        ?.status,
    ).toBe("done");
    const readme = await readFile(path.join(appDir!, "README.md"), "utf8");
    expect(readme).toContain("Recovered escaped whitespace");
  });

  it("reorders screens and imports Apple metadata references without storing secrets", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private recipe app for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();
    await applyAppStudioPrompt({ appDir: appDir!, prompt: "Add a shopping list screen." });
    const spec = await readProductSpec(appDir!);
    expect(spec).not.toBeNull();
    const reversed = [...spec!.screens].toReversed().map((screen) => screen.id);

    const reordered = await reorderAppStudioScreens({ appDir: appDir!, screenIds: reversed });
    expect(reordered.snapshot.selectedProject?.screens[0]?.id).toBe(reversed[0]);

    const imported = await importAppStudioAppleFacts({
      appDir: appDir!,
      facts: {
        appStoreConnectAppId: "1234567890",
        sku: "recipe-app-ios",
        teamId: "ABCDE12345",
        apiKeyProfileRef: "openclaw-appstore-api",
        supportUrl: "https://example.com/support",
        privacyUrl: "https://example.com/privacy",
      },
    });
    expect(imported.snapshot.selectedProject?.appStoreConnect.sku).toBe("recipe-app-ios");
    expect(JSON.stringify(imported.snapshot.selectedProject?.appStoreConnect)).not.toContain(
      "PRIVATE KEY",
    );
  });

  it("imports optional screen pictures into screens and a visible flow map", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private habit tracker for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();

    const imported = await importAppStudioScreenImages({
      appDir: appDir!,
      notes: "Home -> Settings",
      images: [
        {
          fileName: "home-screen.png",
          mimeType: "image/png",
          dataBase64: Buffer.from("fake-home-image").toString("base64"),
        },
        {
          fileName: "settings-screen.png",
          mimeType: "image/png",
          dataBase64: Buffer.from("fake-settings-image").toString("base64"),
        },
      ],
      now: new Date("2026-05-24T12:10:00.000Z"),
    });

    expect(imported.snapshot.selectedProject?.screens.map((screen) => screen.title)).toContain("Home");
    expect(imported.snapshot.selectedProject?.screens.map((screen) => screen.title)).toContain(
      "Settings",
    );
    expect(imported.snapshot.selectedProject?.screenFlow.edges).toContainEqual(
      expect.objectContaining({
        fromScreenId: "home",
        toScreenId: "settings",
        trigger: "Tap “Open Settings”",
      }),
    );
    expect(imported.snapshot.selectedProject?.visualInputs).toHaveLength(2);
    const brief = await readFile(
      path.join(appDir!, ".openclaw-app-builder", "screen-image-brief.json"),
      "utf8",
    );
    expect(brief).toContain("home-screen.png");
    const visionTask = await readFile(
      path.join(appDir!, ".openclaw-app-builder", "screen-vision-task.md"),
      "utf8",
    );
    expect(visionTask).toContain("Required output shape");
    expect(visionTask).toContain("Home -> Settings");
    const models = await readFile(path.join(appDir!, "Sources", "AppModels.swift"), "utf8");
    expect(models).toContain("AppScreenFlow");
  });

  it("edits screen connections and regenerates Swift screen-flow model plus tests", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private notes app for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();
    await applyAppStudioPrompt({
      appDir: appDir!,
      prompt: "Add a settings screen.",
      now: new Date("2026-05-24T12:05:00.000Z"),
    });
    const spec = await readProductSpec(appDir!);
    const from = spec?.screens[0];
    const to = spec?.screens.find((screen) => screen.title === "Settings") ?? spec?.screens.at(-1);
    expect(from).toBeTruthy();
    expect(to).toBeTruthy();

    const updated = await updateAppStudioScreenFlow({
      appDir: appDir!,
      screenFlow: {
        entryScreenId: from!.id,
        edges: [
          {
            id: `${from!.id}-to-${to!.id}`,
            fromScreenId: from!.id,
            toScreenId: to!.id,
            label: "Open settings",
            trigger: "Tap the settings button",
          },
        ],
      },
      now: new Date("2026-05-24T12:06:00.000Z"),
    });

    expect(updated.snapshot.selectedProject?.screenFlow.edges).toEqual([
      expect.objectContaining({
        fromScreenId: from!.id,
        toScreenId: to!.id,
        label: "Open settings",
        trigger: "Tap the settings button",
      }),
    ]);
    const models = await readFile(path.join(appDir!, "Sources", "AppModels.swift"), "utf8");
    expect(models).toContain("Open settings");
    expect(models).toContain("Tap the settings button");
    const tests = await readFile(path.join(appDir!, "Tests", "GeneratedAppTests.swift"), "utf8");
    expect(tests).toContain("XCTAssertEqual(AppScreenFlow.defaults.count, 1)");

    await updateAppStudioScreenFlow({
      appDir: appDir!,
      screenFlow: {
        entryScreenId: from!.id,
        edges: [],
      },
      now: new Date("2026-05-24T12:07:00.000Z"),
    });
    const emptyFlowTests = await readFile(
      path.join(appDir!, "Tests", "GeneratedAppTests.swift"),
      "utf8",
    );
    expect(emptyFlowTests).toContain("XCTAssertEqual(AppScreenFlow.defaults.count, 0)");
  });

  it("applies screen analysis JSON into screens, flow links, questions, and Swift tests", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private planning app for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();

    const applied = await applyAppStudioScreenAnalysis({
      appDir: appDir!,
      analysis: JSON.stringify({
        screens: [
          {
            title: "Home",
            purpose: "Show today's plan and a settings shortcut.",
            visibleText: ["Today", "Settings"],
            sourceImageIds: ["home-image"],
          },
          {
            title: "Settings",
            purpose: "Adjust local-only preferences.",
            visibleText: ["Privacy", "Reminders"],
            sourceImageIds: ["settings-image"],
          },
        ],
        connections: [
          {
            fromTitle: "Home",
            toTitle: "Settings",
            label: "Open Settings",
            trigger: "Tap the Settings gear",
          },
        ],
        questions: ["Should reminders be local notifications?"],
      }),
      now: new Date("2026-05-24T12:09:00.000Z"),
    });

    expect(applied.snapshot.selectedProject?.screens.map((screen) => screen.title)).toContain(
      "Settings",
    );
    expect(applied.snapshot.selectedProject?.screenFlow.edges).toContainEqual(
      expect.objectContaining({
        fromScreenId: "home",
        toScreenId: "settings",
        label: "Open Settings",
        trigger: "Tap the Settings gear",
      }),
    );
    expect(applied.snapshot.selectedProject?.spec.unresolvedQuestions.join("\n")).toContain(
      "Visual analysis question: Should reminders be local notifications?",
    );
    const report = await readFile(
      path.join(appDir!, ".openclaw-app-builder", "screen-analysis-applied.json"),
      "utf8",
    );
    expect(report).toContain("Open Settings");
    const tests = await readFile(path.join(appDir!, "Tests", "GeneratedAppTests.swift"), "utf8");
    expect(tests).toContain("XCTAssertEqual(AppScreenFlow.defaults.count, 1)");
  });

  it("runs a structure validation gate and exposes the report through the dashboard", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a field guide app for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();

    const validated = await runAppStudioGate({ appDir: appDir!, gate: "validate-structure" });

    expect(validated.receipt.detail).toContain("Project structure");
    expect(validated.snapshot.selectedProject?.latestReports.validation).not.toBeNull();
  });

  it("runs the repair gate and exposes repair evidence through the dashboard", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private habit tracker for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();
    await runAppStudioGate({ appDir: appDir!, gate: "implement" });
    await writeFile(
      path.join(appDir!, "Sources", "ContentView.swift"),
      'import SwiftUI\n\nstruct ContentView: View { var body: some View { Text("Broken") } }\n',
    );

    const repaired = await runAppStudioGate({ appDir: appDir!, gate: "repair" });

    expect(repaired.receipt.detail).toContain("repair loop completed");
    expect(repaired.snapshot.selectedProject?.latestReports.repair).not.toBeNull();
    expect(
      repaired.snapshot.selectedProject?.studio.agentWorkboard.find((agent) => agent.id === "app-builder")
        ?.outputs,
    ).toContain("repair-report.json");
  });

  it("runs the final verifier gate and exposes final verifier evidence", async () => {
    const root = await makeTempDir();
    const created = await createAppStudioProject({
      cwd: root,
      request: "Create a private checklist app for iPhone",
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const appDir = created.snapshot.selectedProject?.appDir;
    expect(appDir).toBeTruthy();
    await runAppStudioGate({ appDir: appDir!, gate: "implement" });

    const verified = await runAppStudioGate({ appDir: appDir!, gate: "final-verify" });

    expect(verified.receipt.detail).toContain("Final verifier");
    expect(verified.snapshot.selectedProject?.latestReports.finalVerifier).not.toBeNull();
    expect(
      verified.snapshot.selectedProject?.studio.agentWorkboard.find(
        (agent) => agent.id === "app-store-verifier",
      )?.outputs,
    ).toContain("final-verifier-report.json");
  });

  it("serves create and snapshot through gateway handlers", async () => {
    const root = await makeTempDir();
    const { api, registerGatewayMethod } = createApi();
    registerAppStudioGatewayMethods(api);

    const created = await invoke(findHandler(registerGatewayMethod, "apps.project.create"), {
      request: "Create a private budget app for the Apple Store",
      appName: "Budget Bird",
      outputDir: path.join(root, "generated-apps", "budget-bird"),
    });
    expect(created.ok).toBe(true);

    const appDir =
      created.ok &&
      (created.payload as Awaited<ReturnType<typeof createAppStudioProject>>).snapshot.selectedProject
        ?.appDir;
    const snapshot = await invoke(findHandler(registerGatewayMethod, "apps.dashboard.snapshot"), {
      appDir,
    });
    expect(snapshot.ok).toBe(true);
    expect(
      snapshot.ok && (snapshot.payload as Awaited<ReturnType<typeof buildAppStudioSnapshot>>).selectedProject?.appName,
    ).toBe("Budget Bird");
  });
});
