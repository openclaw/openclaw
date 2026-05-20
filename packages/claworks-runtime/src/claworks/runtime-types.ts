import type { ConnectorManager } from "../interfaces/connectors/connector-manager.js";
import type { EventKernel } from "../kernel/event-kernel.js";
import type { IngressRouter } from "../kernel/ingress.js";
import type { PlaybookScheduler } from "../kernel/scheduler.js";
import type { RobotInfo, KnowledgeBase } from "../kernel/types.js";
import type { PackLoader, LoadedPack } from "../pack-loader/index.js";
import type { CwDatabase } from "../planes/data/db-types.js";
import { createObjectStore } from "../planes/data/object-store.js";
import { createOntologyEngine } from "../planes/data/ontology-engine.js";
import type { PlaybookEngine } from "../planes/orch/playbook-engine.js";
import type { ClaworksRobotConfig } from "./config-types.js";
import { createRbacGuard, type RobotIdentity } from "./robot-identity.js";

/** 运行时句柄（与 `createClaworksRuntime` 返回值结构一致）。 */
export type ClaworksRuntime = {
  config: ClaworksRobotConfig;
  robot: RobotInfo;
  identity: RobotIdentity;
  rbac: ReturnType<typeof createRbacGuard>;
  ingress: IngressRouter;
  db: CwDatabase;
  objectStore: ReturnType<typeof createObjectStore>;
  ontology: ReturnType<typeof createOntologyEngine>;
  kb: KnowledgeBase;
  playbookEngine: PlaybookEngine;
  kernel: EventKernel;
  loadedPacks: LoadedPack[];
  packLoader: PackLoader;
  connectorManager: ConnectorManager;
  scheduler: PlaybookScheduler;
  logger?: (msg: string) => void;
  _outboxFlushTimer?: ReturnType<typeof setInterval>;
  close: () => void;
};
