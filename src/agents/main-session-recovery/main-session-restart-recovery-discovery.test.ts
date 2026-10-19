import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionStoreTarget } from "../../config/sessions/targets-collision.js";
import { discoverRestartRecoveryStoreTargets } from "./main-session-restart-recovery-shared.js";

const mocks = vi.hoisted(() => ({
  readInventory: vi.fn<() => Promise<SessionStoreTarget[]>>(),
  readRefusal: vi.fn(),
  resolveDirs: vi.fn<() => Promise<string[]>>(),
  resolveStorePath: vi.fn<() => string>(),
}));

vi.mock("../../config/sessions.js", () => ({
  listConfiguredSessionStoreAgentIds: () => ["main"],
  resolveSessionStorePathCore: mocks.resolveStorePath,
}));
vi.mock("../../config/sessions/session-store-target-inventory.js", () => ({
  prepareSessionStoreTargetInventory: vi.fn(),
}));
vi.mock("../../config/sessions/session-store-target-runtime.js", () => ({
  prepareSessionStoreTargetInventoryRead: () => ({ withRead: mocks.readInventory }),
}));
vi.mock("../../state/agent-database-admission.js", () => ({
  readAgentDatabaseAdmissionRefusal: mocks.readRefusal,
}));
vi.mock("../session-dirs.js", () => ({
  resolveAgentSessionDirs: mocks.resolveDirs,
}));

const stateDir = path.resolve("recovery-discovery-state");
const targets = ["main", "other"].map((agentId) => ({
  agentId,
  storePath: path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveDirs.mockResolvedValue(targets.map((target) => path.dirname(target.storePath)));
  mocks.resolveStorePath.mockReturnValue(targets[0]!.storePath);
});

it("does not inspect sessions when recovery stops during store discovery", async () => {
  const inventory = createDeferred<SessionStoreTarget[]>();
  mocks.readInventory.mockReturnValue(inventory.promise);
  let active = true;
  const discovery = discoverRestartRecoveryStoreTargets({
    cfg: {},
    stateDir,
    shouldContinue: () => active,
  });
  active = false;
  inventory.resolve(targets);

  await expect(discovery).resolves.toEqual([]);
});

it("honors admission refusal after asynchronous store inventory completes", async () => {
  const directories = createDeferred<string[]>();
  mocks.resolveDirs.mockReturnValue(directories.promise);
  const discovery = discoverRestartRecoveryStoreTargets({ stateDir });
  mocks.readRefusal.mockImplementation((agentId) => agentId === "main");
  directories.resolve(targets.map((target) => path.dirname(target.storePath)));

  await expect(discovery).resolves.toEqual([targets[1]]);
});
