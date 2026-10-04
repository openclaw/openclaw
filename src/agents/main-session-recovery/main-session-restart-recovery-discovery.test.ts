import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { SessionStoreTarget } from "../../config/sessions/targets-collision.js";
import { discoverRestartRecoveryStoreTargets } from "./main-session-restart-recovery-shared.js";

const mocks = vi.hoisted(() => ({
  hasStatus: vi.fn<(scope: { agentId?: string }) => Promise<boolean>>(),
  readInventory: vi.fn<() => Promise<SessionStoreTarget[]>>(),
  readRefusal: vi.fn(),
  resolveDirs: vi.fn<() => Promise<string[]>>(),
  resolveStorePath: vi.fn<() => string>(),
}));

vi.mock("../../config/sessions.js", () => ({
  listConfiguredSessionStoreAgentIds: () => ["main"],
  resolveSessionStorePathCore: mocks.resolveStorePath,
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  hasSessionEntriesByStatusReadOnly: mocks.hasStatus,
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
  mocks.hasStatus.mockResolvedValue(true);
});

it("does not inspect sessions when recovery stops during store discovery", async () => {
  const inventory = createDeferred<SessionStoreTarget[]>();
  mocks.readInventory.mockReturnValue(inventory.promise);
  let active = true;
  const discovery = discoverRestartRecoveryStoreTargets({
    cfg: {},
    stateDir,
    statuses: ["running"],
    shouldContinue: () => active,
  });
  active = false;
  inventory.resolve(targets);

  await expect(discovery).resolves.toEqual([]);
  expect(mocks.hasStatus).not.toHaveBeenCalled();
});

it("discards a delayed status result and skips later stores after recovery stops", async () => {
  const entered = createDeferred();
  const status = createDeferred<boolean>();
  mocks.hasStatus.mockImplementationOnce(() => {
    entered.resolve();
    return status.promise;
  });
  let active = true;
  const discovery = discoverRestartRecoveryStoreTargets({
    stateDir,
    statuses: ["running"],
    shouldContinue: () => active,
  });
  await awaitGateBeforeSettlement(entered.promise, discovery, "status read did not start");
  active = false;
  status.resolve(true);

  await expect(discovery).resolves.toEqual([]);
  expect(mocks.hasStatus).toHaveBeenCalledTimes(1);
});

it("drops earlier eligible stores whose admission is refused during a later read", async () => {
  const entered = createDeferred();
  const status = createDeferred<boolean>();
  mocks.hasStatus.mockResolvedValueOnce(true).mockImplementationOnce(() => {
    entered.resolve();
    return status.promise;
  });
  const discovery = discoverRestartRecoveryStoreTargets({ stateDir, statuses: ["running"] });
  await awaitGateBeforeSettlement(entered.promise, discovery, "second status read did not start");
  mocks.readRefusal.mockImplementation((agentId) => agentId === "main");
  status.resolve(true);

  await expect(discovery).resolves.toEqual([targets[1]]);
});
