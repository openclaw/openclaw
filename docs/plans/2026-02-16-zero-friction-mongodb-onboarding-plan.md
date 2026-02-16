# Zero-Friction MongoDB Onboarding Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Design:** See research at `docs/research/2026-02-16-docker-auto-onboarding-research.md`
> **Prior infrastructure:** `docs/plans/2026-02-16-docker-compose-mongodb-dx-plan.md` (COMPLETED)

**Goal:** Make MongoDB setup fully automatic in the ClawMongo onboarding wizard so users never manually touch Docker or MongoDB commands. Everything out of the box.

**Architecture:** A new `src/docker/mongodb-docker.ts` module provides Docker detection, image management, and compose orchestration using the existing `execDockerRaw()`/`execDocker()` spawn pattern (zero new deps). The onboarding wizard (`src/wizard/onboarding-memory.ts`) gains a new auto-setup flow that runs BEFORE the manual URI prompt. The flow is: detect existing MongoDB -> detect Docker -> auto-start with fallback tiers -> auto-configure. Every step has a fallback. The user always lands on a working state.

**Tech Stack:** TypeScript, Node.js child_process.spawn (via existing execDocker), Docker Compose, @clack/prompts (via WizardPrompter), mongodb driver (dynamic import)

**Prerequisites:**

- Docker Compose infrastructure completed (Task 56 - DONE)
- `docker/mongodb/docker-compose.mongodb.yml` with 3 profiles (standalone/replicaset/fullstack) - EXISTS
- `docker/mongodb/start.sh` convenience wrapper - EXISTS
- `src/agents/sandbox/docker.ts` with execDocker/execDockerRaw - EXISTS
- `src/memory/mongodb-topology.ts` with detectTopology/topologyToTier - EXISTS
- `src/wizard/onboarding-memory.ts` with setupMemoryBackend - EXISTS

---

## Relevant Codebase Files

### Patterns to Follow

- `src/agents/sandbox/docker.ts` (lines 27-105) - `execDockerRaw()` / `execDocker()` spawn pattern. REUSE for all Docker CLI calls.
- `src/agents/sandbox/docker.ts` (lines 163-198) - `dockerImageExists()`, `dockerContainerState()` patterns. REUSE for container inspection.
- `src/wizard/prompts.ts` (lines 1-53) - `WizardPrompter` interface: select, text, confirm, note, progress. ALL wizard UI uses this.
- `src/wizard/onboarding-memory.ts` (lines 16-63) - `setupMemoryBackend()` current flow. This is WHAT CHANGES.
- `src/wizard/onboarding-memory.ts` (lines 65-312) - `setupMongoDBMemory()` flow. Manual URI prompt + topology detection. NEW FLOW goes BEFORE this.
- `src/memory/mongodb-topology.ts` (lines 19-62) - `detectTopology()` 3 safe probes. REUSE after auto-start completes.
- `src/wizard/onboarding-memory.test.ts` (lines 1-27) - `createMockPrompter()` pattern. REUSE for new tests.
- `docker/mongodb/docker-compose.mongodb.yml` - The compose spec driven by the auto-start module.

### Configuration Files

- `docker/mongodb/docker-compose.mongodb.yml` - 3 profiles, env vars for ports/passwords
- `docker/mongodb/start.sh` - Reference for the shell-based flow (to be replicated in TS)
- `docker/mongodb/mongod.conf` - mongod configuration (mounted into container)
- `docker/mongodb/mongot.conf` - mongot configuration (mounted into container)

### Key Constraints

- **NO new dependencies** - use `execDockerRaw`/`execDocker` from sandbox/docker.ts
- **NO auto-install Docker** - too invasive
- **NO auto-start Docker daemon** - platform-specific
- **All changes additive** - never modify existing builtin/QMD code paths
- **WizardPrompter interface** - all UI goes through prompter (testable via mock)
- **Dynamic imports** - `import("mongodb")` for optional MongoDB driver
- **pnpm** not npm - for all package commands

---

## Phase 1: Docker Detection & Orchestration Module (Core Engine)

> **Exit Criteria:** `src/docker/mongodb-docker.ts` exists with all Docker detection, image management, and compose orchestration functions. All functions are individually tested. Zero new dependencies.

### Task 1.1: Create Docker Detection Functions

**Files:**

- Create: `src/docker/mongodb-docker.ts`
- Test: `src/docker/mongodb-docker.test.ts`

**Step 1: Write failing tests for Docker detection**

```typescript
// src/docker/mongodb-docker.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execDocker and execDockerRaw from sandbox
const mockExecDocker = vi.hoisted(() => vi.fn());
const mockExecDockerRaw = vi.hoisted(() => vi.fn());
vi.mock("../agents/sandbox/docker.js", () => ({
  execDocker: mockExecDocker,
  execDockerRaw: mockExecDockerRaw,
}));

describe("isDockerInstalled", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when docker --version succeeds", async () => {
    const { isDockerInstalled } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "Docker version 24.0.7", stderr: "", code: 0 });
    expect(await isDockerInstalled()).toBe(true);
  });

  it("returns false when docker --version fails", async () => {
    const { isDockerInstalled } = await import("./mongodb-docker.js");
    mockExecDocker.mockRejectedValue(new Error("command not found"));
    expect(await isDockerInstalled()).toBe(false);
  });
});

describe("isDockerDaemonRunning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when docker info succeeds", async () => {
    const { isDockerDaemonRunning } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "Server: Docker Engine", stderr: "", code: 0 });
    expect(await isDockerDaemonRunning()).toBe(true);
  });

  it("returns false when docker info fails", async () => {
    const { isDockerDaemonRunning } = await import("./mongodb-docker.js");
    mockExecDocker.mockRejectedValue(new Error("Cannot connect to Docker daemon"));
    expect(await isDockerDaemonRunning()).toBe(false);
  });
});

describe("isDockerComposeAvailable", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 'v2' when docker compose version succeeds", async () => {
    const { isDockerComposeAvailable } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({
      stdout: "Docker Compose version v2.23.0",
      stderr: "",
      code: 0,
    });
    expect(await isDockerComposeAvailable()).toBe("v2");
  });

  it("returns false when docker compose is not available", async () => {
    const { isDockerComposeAvailable } = await import("./mongodb-docker.js");
    mockExecDocker.mockRejectedValue(new Error("not found"));
    expect(await isDockerComposeAvailable()).toBe(false);
  });
});
```

**Step 2: Run tests, verify they fail**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: FAIL with "Cannot find module mongodb-docker.js"

**Step 3: Implement Docker detection functions**

```typescript
// src/docker/mongodb-docker.ts
import { execDocker, execDockerRaw } from "../agents/sandbox/docker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("docker:mongodb");

/**
 * Check if Docker CLI is installed.
 * Does NOT check if daemon is running.
 */
export async function isDockerInstalled(): Promise<boolean> {
  try {
    await execDocker(["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Docker daemon is running.
 * Assumes Docker CLI is installed.
 */
export async function isDockerDaemonRunning(): Promise<boolean> {
  try {
    await execDocker(["info"], { allowFailure: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Docker Compose is available and which version.
 * Returns "v2" for `docker compose` (plugin) or false if not available.
 */
export async function isDockerComposeAvailable(): Promise<"v2" | false> {
  try {
    await execDocker(["compose", "version"]);
    return "v2";
  } catch {
    return false;
  }
}

export type DockerStatus = {
  installed: boolean;
  daemonRunning: boolean;
  composeAvailable: "v2" | false;
};

/**
 * Full Docker environment check. All three steps: CLI, daemon, compose.
 */
export async function checkDockerEnvironment(): Promise<DockerStatus> {
  const installed = await isDockerInstalled();
  if (!installed) {
    return { installed: false, daemonRunning: false, composeAvailable: false };
  }
  const daemonRunning = await isDockerDaemonRunning();
  if (!daemonRunning) {
    return { installed: true, daemonRunning: false, composeAvailable: false };
  }
  const composeAvailable = await isDockerComposeAvailable();
  return { installed: true, daemonRunning: true, composeAvailable };
}
```

**Step 4: Run tests, verify they pass**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/docker/mongodb-docker.ts src/docker/mongodb-docker.test.ts
git commit -m "feat(docker): add Docker detection functions (isDockerInstalled, isDockerDaemonRunning, isDockerComposeAvailable)"
```

---

### Task 1.2: Add Existing MongoDB Detection

**Files:**

- Modify: `src/docker/mongodb-docker.ts`
- Modify: `src/docker/mongodb-docker.test.ts`

**Step 1: Write failing tests for existing MongoDB detection**

```typescript
// Add to mongodb-docker.test.ts

// Mock mongodb driver
const mockMongoClient = vi.hoisted(() => {
  const mockDb = {
    admin: () => ({
      command: vi.fn().mockResolvedValue({ ok: 1 }),
    }),
  };
  return vi.fn(function (this: any) {
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.db = vi.fn().mockReturnValue(mockDb);
    this.close = vi.fn().mockResolvedValue(undefined);
  });
});
vi.mock("mongodb", () => ({ MongoClient: mockMongoClient }));

describe("detectExistingMongoDB", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns connected=true when MongoDB is reachable at localhost:27017", async () => {
    const { detectExistingMongoDB } = await import("./mongodb-docker.js");
    const result = await detectExistingMongoDB();
    expect(result.connected).toBe(true);
    expect(result.uri).toBe("mongodb://localhost:27017/openclaw");
  });

  it("returns connected=false when MongoDB is not reachable", async () => {
    const { detectExistingMongoDB } = await import("./mongodb-docker.js");
    mockMongoClient.mockImplementation(function (this: any) {
      this.connect = vi.fn().mockRejectedValue(new Error("connection refused"));
      this.close = vi.fn().mockResolvedValue(undefined);
    });
    const result = await detectExistingMongoDB();
    expect(result.connected).toBe(false);
  });

  it("returns connected=false when mongodb package is not installed", async () => {
    const { detectExistingMongoDB } = await import("./mongodb-docker.js");
    // Dynamic import failure simulation handled in implementation
    const result = await detectExistingMongoDB();
    // depends on mock -- but the function should never throw
    expect(typeof result.connected).toBe("boolean");
  });
});
```

**Step 2: Run tests, verify they fail**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: FAIL — `detectExistingMongoDB is not a function`

**Step 3: Implement existing MongoDB detection**

Add to `src/docker/mongodb-docker.ts`:

```typescript
export type ExistingMongoDBResult = {
  connected: boolean;
  uri?: string;
  isDocker?: boolean;
};

/**
 * Try to connect to MongoDB at localhost:27017 to detect existing instances.
 * Uses 5-second timeout. Returns connected=true if MongoDB is already running.
 * This should be called BEFORE attempting Docker auto-start.
 */
export async function detectExistingMongoDB(port = 27017): Promise<ExistingMongoDBResult> {
  const uri = `mongodb://localhost:${port}/openclaw`;
  try {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
    });
    try {
      await client.connect();
      await client.db().admin().command({ ping: 1 });

      // Check if it's running in Docker
      let isDocker = false;
      try {
        const state = await dockerContainerState("clawmongo-mongod");
        isDocker = state.running;
      } catch {
        // Not a Docker container or Docker not available
      }
      if (!isDocker) {
        try {
          const state = await dockerContainerState("clawmongo-mongod-standalone");
          isDocker = state.running;
        } catch {
          // Not a Docker container
        }
      }

      return { connected: true, uri, isDocker };
    } finally {
      await client.close().catch(() => {});
    }
  } catch {
    return { connected: false };
  }
}

// Import dockerContainerState from sandbox (already exists)
import { dockerContainerState } from "../agents/sandbox/docker.js";
```

**Step 4: Run tests, verify they pass**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/docker/mongodb-docker.ts src/docker/mongodb-docker.test.ts
git commit -m "feat(docker): add existing MongoDB detection at localhost:27017"
```

---

### Task 1.3: Add Port Conflict Detection

**Files:**

- Modify: `src/docker/mongodb-docker.ts`
- Modify: `src/docker/mongodb-docker.test.ts`

**Step 1: Write failing tests**

```typescript
describe("isPortInUse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when port is in use", async () => {
    const { isPortInUse } = await import("./mongodb-docker.js");
    // Use Node.js net to actually test — OR mock
    // Implementation uses net.createServer + listen error
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const port = (server.address() as any).port;
    expect(await isPortInUse(port)).toBe(true);
    server.close();
  });

  it("returns false when port is free", async () => {
    const { isPortInUse } = await import("./mongodb-docker.js");
    // Port 59999 is very unlikely to be in use
    expect(await isPortInUse(59999)).toBe(false);
  });
});
```

**Step 2: Implement port detection**

Add to `src/docker/mongodb-docker.ts`:

```typescript
import net from "node:net";

/**
 * Check if a port is in use on localhost.
 * Uses net.createServer to probe — fast and reliable.
 */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });
}
```

**Step 3: Run tests, verify they pass**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/docker/mongodb-docker.ts src/docker/mongodb-docker.test.ts
git commit -m "feat(docker): add port conflict detection"
```

---

### Task 1.4: Add Docker Compose Orchestration

**Files:**

- Modify: `src/docker/mongodb-docker.ts`
- Modify: `src/docker/mongodb-docker.test.ts`

**Step 1: Write failing tests for compose orchestration**

```typescript
describe("getComposeFilePath", () => {
  it("resolves to docker/mongodb/docker-compose.mongodb.yml relative to package root", async () => {
    const { getComposeFilePath } = await import("./mongodb-docker.js");
    const filePath = await getComposeFilePath();
    expect(filePath).toContain("docker/mongodb/docker-compose.mongodb.yml");
  });
});

describe("runSetupGenerator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs docker compose with setup profile", async () => {
    const { runSetupGenerator } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await runSetupGenerator("/path/to/compose.yml");
    expect(mockExecDocker).toHaveBeenCalledWith(
      expect.arrayContaining([
        "compose",
        "-f",
        "/path/to/compose.yml",
        "--profile",
        "setup",
        "run",
        "--rm",
        "setup-generator",
      ]),
      expect.anything(),
    );
  });
});

describe("startMongoDBCompose", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts fullstack profile with setup first", async () => {
    const { startMongoDBCompose } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await startMongoDBCompose("/path/to/compose.yml", "fullstack");
    // setup-generator should be called first (for fullstack and replicaset)
    expect(mockExecDocker).toHaveBeenCalledTimes(2); // setup + up -d
  });

  it("starts standalone without setup", async () => {
    const { startMongoDBCompose } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await startMongoDBCompose("/path/to/compose.yml", "standalone");
    // standalone does NOT need setup-generator
    expect(mockExecDocker).toHaveBeenCalledTimes(1); // just up -d
  });
});

describe("stopMongoDBCompose", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops all profiles", async () => {
    const { stopMongoDBCompose } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await stopMongoDBCompose("/path/to/compose.yml");
    expect(mockExecDocker).toHaveBeenCalledWith(
      expect.arrayContaining([
        "compose",
        "-f",
        "/path/to/compose.yml",
        "--profile",
        "standalone",
        "--profile",
        "replicaset",
        "--profile",
        "fullstack",
        "down",
      ]),
      expect.anything(),
    );
  });
});

describe("waitForMongoDBHealth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves when container becomes healthy", async () => {
    const { waitForMongoDBHealth } = await import("./mongodb-docker.js");
    // Mock docker inspect returning healthy status
    mockExecDocker
      .mockResolvedValueOnce({ stdout: "starting", stderr: "", code: 0 })
      .mockResolvedValueOnce({ stdout: "healthy", stderr: "", code: 0 });
    const result = await waitForMongoDBHealth("clawmongo-mongod", {
      timeoutMs: 5000,
      pollIntervalMs: 100,
    });
    expect(result).toBe(true);
  });

  it("returns false on timeout", async () => {
    const { waitForMongoDBHealth } = await import("./mongodb-docker.js");
    mockExecDocker.mockResolvedValue({ stdout: "starting", stderr: "", code: 0 });
    const result = await waitForMongoDBHealth("clawmongo-mongod", {
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    expect(result).toBe(false);
  });
});
```

**Step 2: Run tests, verify they fail**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: FAIL — functions not found

**Step 3: Implement compose orchestration**

Add to `src/docker/mongodb-docker.ts`:

```typescript
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Get absolute path to docker-compose.mongodb.yml.
 * Resolves relative to the package root (../../docker/mongodb/...).
 */
export async function getComposeFilePath(): Promise<string> {
  // src/docker/mongodb-docker.ts -> ../../docker/mongodb/docker-compose.mongodb.yml
  return path.resolve(__dirname, "..", "..", "docker", "mongodb", "docker-compose.mongodb.yml");
}

export type ComposeTier = "standalone" | "replicaset" | "fullstack";

/**
 * Run the setup-generator (keyfile + auth files).
 * Required before replicaset or fullstack profiles.
 */
export async function runSetupGenerator(
  composeFile: string,
  env?: Record<string, string>,
): Promise<void> {
  log.info("Running setup-generator for auth files...");
  await execDocker(
    ["compose", "-f", composeFile, "--profile", "setup", "run", "--rm", "setup-generator"],
    { allowFailure: false },
  );
}

/**
 * Start MongoDB via docker-compose with the specified profile.
 * Automatically runs setup-generator first for replicaset/fullstack.
 */
export async function startMongoDBCompose(
  composeFile: string,
  tier: ComposeTier,
  env?: Record<string, string>,
): Promise<void> {
  // Setup generator needed for replicaset and fullstack (auth files)
  if (tier !== "standalone") {
    await runSetupGenerator(composeFile, env);
  }

  log.info(`Starting MongoDB with profile: ${tier}`);
  await execDocker(["compose", "-f", composeFile, "--profile", tier, "up", "-d"], {
    allowFailure: false,
  });
}

/**
 * Stop all MongoDB Compose services.
 */
export async function stopMongoDBCompose(composeFile: string): Promise<void> {
  log.info("Stopping all MongoDB Compose services...");
  await execDocker(
    [
      "compose",
      "-f",
      composeFile,
      "--profile",
      "standalone",
      "--profile",
      "replicaset",
      "--profile",
      "fullstack",
      "down",
    ],
    { allowFailure: true },
  );
}

/**
 * Wait for a Docker container to report healthy status.
 * Polls `docker inspect --format '{{.State.Health.Status}}'` until healthy or timeout.
 */
export async function waitForMongoDBHealth(
  containerName: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 120_000; // 2 minutes default
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const result = await execDocker(
        ["inspect", "--format", "{{.State.Health.Status}}", containerName],
        { allowFailure: true },
      );
      const status = result.stdout.trim();
      if (status === "healthy") {
        return true;
      }
      if (status === "unhealthy") {
        log.warn(`Container ${containerName} is unhealthy`);
        return false;
      }
    } catch {
      // Container may not exist yet
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  log.warn(`Timeout waiting for ${containerName} health check (${timeoutMs}ms)`);
  return false;
}
```

**Step 4: Run tests, verify they pass**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/docker/mongodb-docker.ts src/docker/mongodb-docker.test.ts
git commit -m "feat(docker): add Docker Compose orchestration (start, stop, health check)"
```

---

### Task 1.5: Add Fallback Tier Auto-Start with Progress Reporting

**Files:**

- Modify: `src/docker/mongodb-docker.ts`
- Modify: `src/docker/mongodb-docker.test.ts`

**Step 1: Write failing tests for the auto-start orchestrator**

```typescript
describe("autoStartMongoDB", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts fullstack and returns the tier on success", async () => {
    const { autoStartMongoDB } = await import("./mongodb-docker.js");
    // Mock all docker calls to succeed
    mockExecDocker.mockResolvedValue({ stdout: "healthy", stderr: "", code: 0 });
    const progressCalls: string[] = [];
    const result = await autoStartMongoDB({
      composeFile: "/path/to/compose.yml",
      onProgress: (msg) => progressCalls.push(msg),
    });
    expect(result.success).toBe(true);
    expect(result.tier).toBe("fullstack");
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it("falls back to replicaset when fullstack fails", async () => {
    const { autoStartMongoDB } = await import("./mongodb-docker.js");
    let callCount = 0;
    mockExecDocker.mockImplementation(async (args: string[]) => {
      callCount++;
      // Fail the fullstack up -d (call includes "fullstack")
      if (args.includes("fullstack") && args.includes("up")) {
        throw new Error("mongot image not found");
      }
      // Health check for replicaset returns healthy
      if (args.includes("--format") && args.includes("{{.State.Health.Status}}")) {
        return { stdout: "healthy", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const result = await autoStartMongoDB({
      composeFile: "/path/to/compose.yml",
    });
    expect(result.success).toBe(true);
    expect(result.tier).toBe("replicaset");
  });

  it("falls back to standalone when replicaset fails", async () => {
    const { autoStartMongoDB } = await import("./mongodb-docker.js");
    mockExecDocker.mockImplementation(async (args: string[]) => {
      if ((args.includes("fullstack") || args.includes("replicaset")) && args.includes("up")) {
        throw new Error("auth files failed");
      }
      if (args.includes("setup") && args.includes("run")) {
        throw new Error("setup failed");
      }
      if (args.includes("--format") && args.includes("{{.State.Health.Status}}")) {
        return { stdout: "healthy", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const result = await autoStartMongoDB({
      composeFile: "/path/to/compose.yml",
    });
    expect(result.success).toBe(true);
    expect(result.tier).toBe("standalone");
  });

  it("returns success=false when all tiers fail", async () => {
    const { autoStartMongoDB } = await import("./mongodb-docker.js");
    mockExecDocker.mockRejectedValue(new Error("everything failed"));
    const result = await autoStartMongoDB({
      composeFile: "/path/to/compose.yml",
    });
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run tests, verify they fail**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: FAIL — `autoStartMongoDB is not a function`

**Step 3: Implement the auto-start orchestrator with fallback tiers**

Add to `src/docker/mongodb-docker.ts`:

```typescript
export type AutoStartResult = {
  success: boolean;
  tier?: ComposeTier;
  uri?: string;
  error?: string;
};

const TIER_CONTAINERS: Record<ComposeTier, string[]> = {
  fullstack: ["clawmongo-mongod", "clawmongo-mongot"],
  replicaset: ["clawmongo-mongod"],
  standalone: ["clawmongo-mongod-standalone"],
};

const TIER_URIS: Record<ComposeTier, string> = {
  fullstack: "mongodb://admin:admin@localhost:27017/?authSource=admin&replicaSet=rs0",
  replicaset: "mongodb://admin:admin@localhost:27017/?authSource=admin&replicaSet=rs0",
  standalone: "mongodb://localhost:27017/openclaw",
};

const FALLBACK_ORDER: ComposeTier[] = ["fullstack", "replicaset", "standalone"];

/**
 * Auto-start MongoDB with fallback tiers: fullstack -> replicaset -> standalone.
 * Reports progress via onProgress callback.
 * Returns the tier that succeeded, or success=false if all fail.
 */
export async function autoStartMongoDB(options: {
  composeFile: string;
  onProgress?: (message: string) => void;
  healthTimeoutMs?: number;
}): Promise<AutoStartResult> {
  const { composeFile, onProgress, healthTimeoutMs = 120_000 } = options;
  const report = onProgress ?? (() => {});

  for (const tier of FALLBACK_ORDER) {
    try {
      report(`Starting MongoDB (${tier})...`);

      // Stop any previously running services before trying next tier
      await stopMongoDBCompose(composeFile).catch(() => {});

      await startMongoDBCompose(composeFile, tier);

      // Wait for primary container to be healthy
      const primaryContainer = TIER_CONTAINERS[tier]![0]!;
      report(`Waiting for ${primaryContainer} to be ready...`);
      const healthy = await waitForMongoDBHealth(primaryContainer, {
        timeoutMs: healthTimeoutMs,
        pollIntervalMs: 2_000,
      });

      if (!healthy) {
        log.warn(`${tier}: primary container did not become healthy`);
        continue;
      }

      // For fullstack, also wait for mongot
      if (tier === "fullstack") {
        report("Waiting for mongot search engine...");
        const mongotHealthy = await waitForMongoDBHealth("clawmongo-mongot", {
          timeoutMs: healthTimeoutMs,
          pollIntervalMs: 2_000,
        });
        if (!mongotHealthy) {
          log.warn("fullstack: mongot did not become healthy, falling back");
          continue;
        }
      }

      const uri = TIER_URIS[tier];
      report(`MongoDB started successfully (${tier})`);
      log.info(`Auto-started MongoDB with tier: ${tier}`);
      return { success: true, tier, uri };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`${tier} failed: ${msg}`);
      report(`${tier} failed, trying next tier...`);
    }
  }

  return { success: false, error: "All MongoDB start attempts failed" };
}

/**
 * Check if ClawMongo Docker containers are already running.
 */
export async function getRunningClawMongoContainers(): Promise<{
  running: boolean;
  tier?: ComposeTier;
  containers: string[];
}> {
  const containers: string[] = [];

  // Check fullstack containers
  try {
    const mongodState = await dockerContainerState("clawmongo-mongod");
    if (mongodState.running) containers.push("clawmongo-mongod");
    const mongotState = await dockerContainerState("clawmongo-mongot");
    if (mongotState.running) containers.push("clawmongo-mongot");
    if (containers.includes("clawmongo-mongod") && containers.includes("clawmongo-mongot")) {
      return { running: true, tier: "fullstack", containers };
    }
    if (containers.includes("clawmongo-mongod")) {
      return { running: true, tier: "replicaset", containers };
    }
  } catch {
    // Docker not available
  }

  // Check standalone
  try {
    const standaloneState = await dockerContainerState("clawmongo-mongod-standalone");
    if (standaloneState.running) {
      return { running: true, tier: "standalone", containers: ["clawmongo-mongod-standalone"] };
    }
  } catch {
    // Docker not available
  }

  return { running: false, containers: [] };
}
```

**Step 4: Run tests, verify they pass**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/docker/mongodb-docker.ts src/docker/mongodb-docker.test.ts
git commit -m "feat(docker): add autoStartMongoDB with fallback tiers (fullstack -> replicaset -> standalone)"
```

---

## Phase 2: Wizard Integration (Zero-Friction Auto-Setup Flow)

> **Exit Criteria:** When a user selects MongoDB in the onboarding wizard, the wizard automatically detects Docker, starts MongoDB, and configures the connection. The user never types a URI manually (unless Docker is unavailable). The manual URI path still works as a fallback.

### Task 2.1: Create Auto-Setup Orchestrator for Wizard

**Files:**

- Create: `src/wizard/mongodb-auto-setup.ts`
- Create: `src/wizard/mongodb-auto-setup.test.ts`

**Step 1: Write failing tests for the auto-setup wizard flow**

```typescript
// src/wizard/mongodb-auto-setup.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "./prompts.js";

// Mock the Docker module
const mockCheckDockerEnvironment = vi.hoisted(() => vi.fn());
const mockDetectExistingMongoDB = vi.hoisted(() => vi.fn());
const mockAutoStartMongoDB = vi.hoisted(() => vi.fn());
const mockGetComposeFilePath = vi.hoisted(() => vi.fn());
const mockGetRunningClawMongoContainers = vi.hoisted(() => vi.fn());
const mockIsPortInUse = vi.hoisted(() => vi.fn());

vi.mock("../docker/mongodb-docker.js", () => ({
  checkDockerEnvironment: mockCheckDockerEnvironment,
  detectExistingMongoDB: mockDetectExistingMongoDB,
  autoStartMongoDB: mockAutoStartMongoDB,
  getComposeFilePath: mockGetComposeFilePath,
  getRunningClawMongoContainers: mockGetRunningClawMongoContainers,
  isPortInUse: mockIsPortInUse,
}));

function createMockPrompter(responses?: {
  selectResponses?: unknown[];
  textResponses?: string[];
  confirmResponses?: boolean[];
}): WizardPrompter {
  const selectResponses = [...(responses?.selectResponses ?? [])];
  const textResponses = [...(responses?.textResponses ?? [])];
  const confirmResponses = [...(responses?.confirmResponses ?? [true])];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => selectResponses.shift()),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => textResponses.shift() ?? ""),
    confirm: vi.fn(async () => confirmResponses.shift() ?? true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("attemptAutoSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComposeFilePath.mockResolvedValue("/path/to/compose.yml");
    mockIsPortInUse.mockResolvedValue(false);
  });

  it("reuses existing MongoDB when found", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({
      connected: true,
      uri: "mongodb://localhost:27017/openclaw",
      isDocker: true,
    });
    const prompter = createMockPrompter({ confirmResponses: [true] });
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(true);
    expect(result.uri).toBe("mongodb://localhost:27017/openclaw");
    expect(result.source).toBe("existing");
  });

  it("auto-starts Docker MongoDB when no existing found and Docker available", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: true,
      composeAvailable: "v2",
    });
    mockGetRunningClawMongoContainers.mockResolvedValue({ running: false, containers: [] });
    mockAutoStartMongoDB.mockResolvedValue({
      success: true,
      tier: "fullstack",
      uri: "mongodb://admin:admin@localhost:27017/?authSource=admin&replicaSet=rs0",
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(true);
    expect(result.uri).toContain("localhost:27017");
    expect(result.source).toBe("docker-auto");
    expect(result.tier).toBe("fullstack");
  });

  it("reconnects to existing ClawMongo containers", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({
      connected: true,
      uri: "mongodb://localhost:27017/openclaw",
      isDocker: true,
    });
    const prompter = createMockPrompter({ confirmResponses: [true] });
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(true);
    expect(result.source).toBe("existing");
  });

  it("falls back to manual when Docker is not available", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: false,
      daemonRunning: false,
      composeAvailable: false,
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Docker");
  });

  it("falls back to manual when Docker daemon is not running", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: false,
      composeAvailable: false,
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Docker");
  });

  it("falls back to manual when all Docker tiers fail", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: true,
      composeAvailable: "v2",
    });
    mockGetRunningClawMongoContainers.mockResolvedValue({ running: false, containers: [] });
    mockAutoStartMongoDB.mockResolvedValue({ success: false, error: "all tiers failed" });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    expect(result.success).toBe(false);
  });

  it("detects port conflict and shows helpful message", async () => {
    const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
    // Port in use but NOT MongoDB
    mockDetectExistingMongoDB.mockResolvedValue({ connected: false });
    mockIsPortInUse.mockResolvedValue(true);
    mockCheckDockerEnvironment.mockResolvedValue({
      installed: true,
      daemonRunning: true,
      composeAvailable: "v2",
    });
    const prompter = createMockPrompter();
    const result = await attemptAutoSetup(prompter);
    // Should note port conflict to user
    expect(prompter.note).toHaveBeenCalled();
  });
});
```

**Step 2: Run tests, verify they fail**

Run: `npx vitest run src/wizard/mongodb-auto-setup.test.ts`
Expected: FAIL — Cannot find module

**Step 3: Implement auto-setup orchestrator**

```typescript
// src/wizard/mongodb-auto-setup.ts
import type { WizardPrompter } from "./prompts.js";
import type { ComposeTier } from "../docker/mongodb-docker.js";

export type AutoSetupResult = {
  success: boolean;
  uri?: string;
  tier?: ComposeTier;
  source?: "existing" | "docker-auto" | "docker-existing";
  reason?: string;
};

/**
 * Attempt zero-friction MongoDB auto-setup.
 *
 * Flow:
 * 1. Check for existing MongoDB at localhost:27017 -> reuse if found
 * 2. Check Docker environment -> if not ready, return failure with reason
 * 3. Check for already-running ClawMongo containers -> reconnect if found
 * 4. Check port 27017 conflict -> warn user if non-MongoDB process is using it
 * 5. Auto-start via docker-compose with fallback tiers
 *
 * Returns success=true with URI if MongoDB is running,
 * or success=false with reason explaining why (for manual fallback).
 */
export async function attemptAutoSetup(prompter: WizardPrompter): Promise<AutoSetupResult> {
  const {
    detectExistingMongoDB,
    checkDockerEnvironment,
    getComposeFilePath,
    getRunningClawMongoContainers,
    autoStartMongoDB,
    isPortInUse,
  } = await import("../docker/mongodb-docker.js");

  // Step 1: Check for existing MongoDB
  const progress = prompter.progress("Checking for MongoDB...");
  progress.update("Looking for existing MongoDB at localhost:27017...");

  const existing = await detectExistingMongoDB();
  if (existing.connected && existing.uri) {
    progress.stop("Found existing MongoDB");
    await prompter.note(
      existing.isDocker
        ? "Found ClawMongo Docker MongoDB already running. Reconnecting."
        : "Found existing MongoDB at localhost:27017. Using it directly.",
      "MongoDB Detected",
    );
    return {
      success: true,
      uri: existing.uri,
      source: "existing",
    };
  }

  // Step 2: Check Docker environment
  progress.update("Checking Docker...");
  const docker = await checkDockerEnvironment();

  if (!docker.installed) {
    progress.stop("Docker not found");
    await prompter.note(
      [
        "Docker is not installed.",
        "",
        "Install Docker Desktop: https://www.docker.com/products/docker-desktop/",
        "",
        "Or enter a MongoDB URI manually in the next step.",
      ].join("\n"),
      "Docker Not Found",
    );
    return { success: false, reason: "Docker is not installed" };
  }

  if (!docker.daemonRunning) {
    progress.stop("Docker not running");
    await prompter.note(
      [
        "Docker is installed but not running.",
        "",
        "Please start Docker Desktop and try again.",
        "",
        "Or enter a MongoDB URI manually in the next step.",
      ].join("\n"),
      "Docker Not Running",
    );
    return { success: false, reason: "Docker daemon is not running" };
  }

  if (!docker.composeAvailable) {
    progress.stop("Docker Compose not available");
    await prompter.note(
      [
        "Docker Compose is not available.",
        "Update Docker Desktop or install the compose plugin.",
        "",
        "Or enter a MongoDB URI manually in the next step.",
      ].join("\n"),
      "Compose Not Available",
    );
    return { success: false, reason: "Docker Compose is not available" };
  }

  // Step 3: Check for already-running ClawMongo containers
  progress.update("Checking for existing ClawMongo containers...");
  const running = await getRunningClawMongoContainers();
  if (running.running && running.tier) {
    // Containers already running - verify MongoDB is accessible
    const recheck = await detectExistingMongoDB();
    if (recheck.connected && recheck.uri) {
      progress.stop(`ClawMongo MongoDB is running (${running.tier})`);
      return {
        success: true,
        uri: recheck.uri,
        tier: running.tier,
        source: "docker-existing",
      };
    }
  }

  // Step 4: Check for port conflicts
  progress.update("Checking port 27017...");
  const portBusy = await isPortInUse(27017);
  if (portBusy) {
    // Port is in use but NOT by MongoDB (we already checked step 1)
    progress.stop("Port 27017 in use");
    await prompter.note(
      [
        "Port 27017 is in use by another process (not MongoDB).",
        "",
        "Options:",
        "1. Stop the process using port 27017",
        "2. Enter a MongoDB URI on a different port manually",
      ].join("\n"),
      "Port Conflict",
    );
    return { success: false, reason: "Port 27017 is in use by another process" };
  }

  // Step 5: Auto-start MongoDB with progress
  const composeFile = await getComposeFilePath();
  progress.update("Starting MongoDB (this may take a minute on first run)...");

  const startResult = await autoStartMongoDB({
    composeFile,
    onProgress: (msg) => progress.update(msg),
    healthTimeoutMs: 120_000,
  });

  if (!startResult.success) {
    progress.stop("MongoDB auto-start failed");
    await prompter.note(
      [
        "Automatic MongoDB setup failed.",
        startResult.error ? `Reason: ${startResult.error}` : "",
        "",
        "You can:",
        "1. Try running manually: ./docker/mongodb/start.sh fullstack",
        "2. Enter a MongoDB URI manually in the next step",
      ]
        .filter(Boolean)
        .join("\n"),
      "Auto-Start Failed",
    );
    return { success: false, reason: startResult.error };
  }

  progress.stop(`MongoDB started (${startResult.tier})`);

  // Show what was started
  const tierLabels: Record<string, string> = {
    fullstack: "Full stack (mongod + mongot) - all features enabled",
    replicaset: "Replica set - transactions + text search (no vector search)",
    standalone: "Standalone - basic features only",
  };
  await prompter.note(
    [
      `MongoDB is running: ${tierLabels[startResult.tier!] ?? startResult.tier}`,
      "",
      `Connection: ${startResult.uri}`,
    ].join("\n"),
    "MongoDB Started",
  );

  return {
    success: true,
    uri: startResult.uri,
    tier: startResult.tier,
    source: "docker-auto",
  };
}
```

**Step 4: Run tests, verify they pass**

Run: `npx vitest run src/wizard/mongodb-auto-setup.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/wizard/mongodb-auto-setup.ts src/wizard/mongodb-auto-setup.test.ts
git commit -m "feat(wizard): add zero-friction auto-setup orchestrator for MongoDB"
```

---

### Task 2.2: Wire Auto-Setup into Onboarding Wizard

**Files:**

- Modify: `src/wizard/onboarding-memory.ts` (lines 65-312 `setupMongoDBMemory`)
- Modify: `src/wizard/onboarding-memory.test.ts`

**Step 1: Write failing tests for the new auto-setup flow**

Add to `src/wizard/onboarding-memory.test.ts`:

```typescript
// Mock the auto-setup module
const mockAttemptAutoSetup = vi.hoisted(() => vi.fn());
vi.mock("./mongodb-auto-setup.js", () => ({
  attemptAutoSetup: mockAttemptAutoSetup,
}));

describe("setupMongoDBMemory auto-setup flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePackageName.mockResolvedValue("@romiluz/clawmongo");
  });

  it("auto-starts MongoDB via Docker when available (ClawMongo package)", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    mockAttemptAutoSetup.mockResolvedValue({
      success: true,
      uri: "mongodb://admin:admin@localhost:27017/?authSource=admin&replicaSet=rs0",
      tier: "fullstack",
      source: "docker-auto",
    });
    const config: OpenClawConfig = {};
    // select: mongodb, then profile auto-selected based on tier
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "community-mongot", "skip"],
      confirmResponses: [true],
    });
    const result = await setupMemoryBackend(config, prompter);
    expect(result.memory?.backend).toBe("mongodb");
    expect(result.memory?.mongodb?.uri).toContain("localhost:27017");
    // Auto-setup was called
    expect(mockAttemptAutoSetup).toHaveBeenCalled();
  });

  it("falls back to manual URI when auto-setup fails", async () => {
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    mockAttemptAutoSetup.mockResolvedValue({
      success: false,
      reason: "Docker not installed",
    });
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default", "skip"],
      textResponses: ["mongodb+srv://user:pass@cluster.mongodb.net/"],
    });
    const result = await setupMemoryBackend(config, prompter);
    expect(result.memory?.backend).toBe("mongodb");
    // Falls back to manual URI prompt
    expect(prompter.text).toHaveBeenCalled();
  });

  it("skips auto-setup for upstream openclaw package", async () => {
    mockResolvePackageName.mockResolvedValue("openclaw");
    const { setupMemoryBackend } = await import("./onboarding-memory.js");
    const config: OpenClawConfig = {};
    const prompter = createMockPrompter({
      selectResponses: ["mongodb", "atlas-default", "skip"],
      textResponses: ["mongodb+srv://user:pass@cluster.mongodb.net/"],
    });
    const result = await setupMemoryBackend(config, prompter);
    // Auto-setup should NOT be called for upstream
    expect(mockAttemptAutoSetup).not.toHaveBeenCalled();
    expect(result.memory?.backend).toBe("mongodb");
  });
});
```

**Step 2: Run tests, verify they fail**

Run: `npx vitest run src/wizard/onboarding-memory.test.ts`
Expected: FAIL — new tests fail (auto-setup not yet wired)

**Step 3: Modify `setupMongoDBMemory` to include auto-setup flow**

The key change to `src/wizard/onboarding-memory.ts` — the `setupMongoDBMemory` function gets a new auto-setup step at the top, BEFORE the manual URI prompt:

```typescript
async function setupMongoDBMemory(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  isClawMongo: boolean,
): Promise<OpenClawConfig> {
  // --- AUTO-SETUP: Try Docker auto-start (ClawMongo only) ---
  let autoUri: string | undefined;
  let autoTier: import("../docker/mongodb-docker.js").ComposeTier | undefined;

  if (isClawMongo) {
    try {
      const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
      const autoResult = await attemptAutoSetup(prompter);
      if (autoResult.success && autoResult.uri) {
        autoUri = autoResult.uri;
        autoTier = autoResult.tier;
      }
      // If not successful, falls through to manual URI prompt below
    } catch {
      // Auto-setup module not available or failed — fall through to manual
    }
  }

  // --- MANUAL URI (existing flow, used as fallback or for upstream) ---
  const existingUri = autoUri ?? config.memory?.mongodb?.uri?.trim();
  const uri = autoUri
    ? autoUri // Skip URI prompt — auto-setup already determined it
    : await prompter.text({
        message: "MongoDB connection URI",
        placeholder: isClawMongo
          ? "mongodb://localhost:27017/openclaw"
          : "mongodb+srv://user:pass@cluster.mongodb.net/",
        initialValue: existingUri,
        validate: (value) => {
          const trimmed = value.trim();
          if (!trimmed) return "URI is required for MongoDB backend";
          if (!trimmed.startsWith("mongodb://") && !trimmed.startsWith("mongodb+srv://"))
            return "URI must start with mongodb:// or mongodb+srv://";
          return undefined;
        },
      });

  // Rest of the function continues with topology detection, profile selection, etc.
  // When autoTier is set, auto-suggest the matching profile.
  // ... (existing code below this point)
```

**IMPORTANT: The profile auto-suggestion logic also needs updating:**

When `autoTier` is set, the suggested profile should be determined from the auto-start tier, not just URI heuristics:

```typescript
// Auto-suggest profile based on auto-start tier OR detected topology OR URI heuristic
const suggestedProfile: MemoryMongoDBDeploymentProfile = (() => {
  if (isAtlas) return "atlas-default";
  if (autoTier === "fullstack") return "community-mongot";
  if (autoTier === "replicaset" || autoTier === "standalone") return "community-bare";
  if (detectedTier) {
    if (detectedTier === "fullstack") return "community-mongot";
    return "community-bare";
  }
  return "community-mongot";
})();
```

**Step 4: Run tests, verify they pass**

Run: `npx vitest run src/wizard/onboarding-memory.test.ts`
Expected: PASS (all existing + new tests)

**Step 5: Run full test suite to verify no regressions**

Run: `npx vitest run src/wizard/onboarding-memory.test.ts src/docker/mongodb-docker.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/wizard/onboarding-memory.ts src/wizard/onboarding-memory.test.ts
git commit -m "feat(wizard): wire auto-setup into onboarding flow (zero-friction Docker MongoDB)"
```

---

### Task 2.3: Add Configure Wizard Docker Auto-Setup

**Files:**

- Modify: `src/commands/configure-memory.ts`

**Step 1: Review the existing configure-memory.ts flow**

Read: `src/commands/configure-memory.ts`

The configure wizard also allows users to set up MongoDB. It should get the same auto-setup offer as onboarding (for ClawMongo package only).

**Step 2: Add auto-setup to configure wizard**

The pattern mirrors the onboarding change: before the manual URI prompt, attempt auto-setup for ClawMongo. Falls back to manual URI on failure.

**Step 3: Run configure-memory tests (if any exist) and full wizard suite**

Run: `npx vitest run src/wizard/ src/commands/`
Expected: PASS — no regressions

**Step 4: Commit**

```bash
git add src/commands/configure-memory.ts
git commit -m "feat(configure): add Docker auto-setup to configure memory wizard"
```

---

## Phase 3: Edge Case Hardening & Error UX

> **Exit Criteria:** Every Docker/MongoDB failure mode produces a helpful, non-technical error message. The user ALWAYS lands on a working state. Permissions errors, image pull failures, network issues, and container conflicts are all handled gracefully.

### Task 3.1: Add Image Pull Progress and Error Handling

**Files:**

- Modify: `src/docker/mongodb-docker.ts`
- Modify: `src/docker/mongodb-docker.test.ts`

**Step 1: Write failing tests**

```typescript
describe("pullImageWithProgress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports progress during image pull", async () => {
    const { pullImageWithProgress } = await import("./mongodb-docker.js");
    // Mock execDockerRaw to simulate streaming output
    mockExecDockerRaw.mockResolvedValue({
      stdout: Buffer.from(
        "Pulling from mongodb/mongodb-community-server\nDigest: sha256:abc\nStatus: Downloaded newer image",
      ),
      stderr: Buffer.alloc(0),
      code: 0,
    });
    const messages: string[] = [];
    await pullImageWithProgress("mongodb/mongodb-community-server:latest", (msg) =>
      messages.push(msg),
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("returns false on pull failure", async () => {
    const { pullImageWithProgress } = await import("./mongodb-docker.js");
    mockExecDockerRaw.mockRejectedValue(new Error("network timeout"));
    const result = await pullImageWithProgress("nonexistent:latest");
    expect(result).toBe(false);
  });
});
```

**Step 2: Implement image pull with progress**

```typescript
/**
 * Pull a Docker image with progress reporting.
 * Returns true on success, false on failure (never throws).
 */
export async function pullImageWithProgress(
  image: string,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  const report = onProgress ?? (() => {});
  report(`Pulling ${image}...`);
  try {
    await execDockerRaw(["pull", image]);
    report(`${image} ready`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to pull ${image}: ${msg}`);
    report(`Failed to pull ${image}`);
    return false;
  }
}
```

**Step 3: Run tests, commit**

Run: `npx vitest run src/docker/mongodb-docker.test.ts`
Expected: PASS

```bash
git add src/docker/mongodb-docker.ts src/docker/mongodb-docker.test.ts
git commit -m "feat(docker): add image pull with progress reporting"
```

---

### Task 3.2: Add Error Classification and User-Friendly Messages

**Files:**

- Create: `src/docker/docker-errors.ts`
- Create: `src/docker/docker-errors.test.ts`

**Step 1: Write failing tests**

```typescript
// src/docker/docker-errors.test.ts
import { describe, it, expect } from "vitest";
import { classifyDockerError, dockerErrorMessage } from "./docker-errors.js";

describe("classifyDockerError", () => {
  it("detects Docker not installed", () => {
    expect(classifyDockerError("command not found: docker")).toBe("not-installed");
  });

  it("detects daemon not running", () => {
    expect(classifyDockerError("Cannot connect to the Docker daemon")).toBe("daemon-not-running");
  });

  it("detects permission denied", () => {
    expect(classifyDockerError("permission denied while trying to connect")).toBe(
      "permission-denied",
    );
  });

  it("detects image not found", () => {
    expect(
      classifyDockerError("manifest for mongodb/mongodb-community-search:latest not found"),
    ).toBe("image-not-found");
  });

  it("detects port conflict", () => {
    expect(classifyDockerError("Bind for 0.0.0.0:27017 failed: port is already allocated")).toBe(
      "port-conflict",
    );
  });

  it("detects network conflict", () => {
    expect(classifyDockerError("network clawmongo-net was found but has incorrect label")).toBe(
      "network-conflict",
    );
  });

  it("returns unknown for unrecognized errors", () => {
    expect(classifyDockerError("some random error")).toBe("unknown");
  });
});

describe("dockerErrorMessage", () => {
  it("returns user-friendly message for each error type", () => {
    expect(dockerErrorMessage("not-installed")).toContain("Docker");
    expect(dockerErrorMessage("daemon-not-running")).toContain("start");
    expect(dockerErrorMessage("permission-denied")).toContain("permission");
    expect(dockerErrorMessage("port-conflict")).toContain("port");
  });
});
```

**Step 2: Implement error classification**

```typescript
// src/docker/docker-errors.ts

export type DockerErrorType =
  | "not-installed"
  | "daemon-not-running"
  | "permission-denied"
  | "image-not-found"
  | "port-conflict"
  | "network-conflict"
  | "volume-conflict"
  | "compose-not-found"
  | "unknown";

const ERROR_PATTERNS: Array<[RegExp, DockerErrorType]> = [
  [/command not found.*docker|docker.*not found/i, "not-installed"],
  [/Cannot connect to the Docker daemon|Is the docker daemon running/i, "daemon-not-running"],
  [/permission denied/i, "permission-denied"],
  [/manifest.*not found|no matching manifest/i, "image-not-found"],
  [/port is already allocated|address already in use|Bind.*failed/i, "port-conflict"],
  [/network.*was found but|network.*already exists/i, "network-conflict"],
  [/volume.*already exists|volume.*in use/i, "volume-conflict"],
  [/no configuration file provided|not a compose file/i, "compose-not-found"],
];

export function classifyDockerError(errorMessage: string): DockerErrorType {
  for (const [pattern, type] of ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return type;
    }
  }
  return "unknown";
}

const USER_MESSAGES: Record<DockerErrorType, string> = {
  "not-installed":
    "Docker is not installed.\nInstall Docker Desktop: https://www.docker.com/products/docker-desktop/",
  "daemon-not-running":
    "Docker is installed but not running.\nPlease start Docker Desktop and try again.",
  "permission-denied":
    "Docker permission denied.\nOn Linux, add your user to the docker group: sudo usermod -aG docker $USER\nThen log out and back in.",
  "image-not-found":
    "A required Docker image could not be found.\nCheck your internet connection and try again.",
  "port-conflict":
    "Port 27017 is already in use.\nStop the service using this port, or configure a different port.",
  "network-conflict":
    "A Docker network conflict was detected.\nRun: docker network rm clawmongo-net\nThen try again.",
  "volume-conflict":
    "A Docker volume conflict was detected.\nRun: docker volume prune\nThen try again.",
  "compose-not-found":
    "Docker Compose configuration not found.\nMake sure the ClawMongo package is properly installed.",
  unknown: "An unexpected Docker error occurred.\nCheck Docker Desktop is running and try again.",
};

export function dockerErrorMessage(type: DockerErrorType): string {
  return USER_MESSAGES[type];
}
```

**Step 3: Run tests, commit**

Run: `npx vitest run src/docker/docker-errors.test.ts`
Expected: PASS

```bash
git add src/docker/docker-errors.ts src/docker/docker-errors.test.ts
git commit -m "feat(docker): add error classification with user-friendly messages"
```

---

### Task 3.3: Wire Error Classification into Auto-Start

**Files:**

- Modify: `src/docker/mongodb-docker.ts` — Import and use `classifyDockerError` + `dockerErrorMessage` in `autoStartMongoDB`
- Modify: `src/wizard/mongodb-auto-setup.ts` — Use error messages in wizard notes

The auto-start should classify errors and show the right message in the progress/note instead of raw Docker errors.

**Step 1: Update autoStartMongoDB to use classifyDockerError**

In each catch block of the fallback loop, classify the error and include the user-friendly message in the log and progress report.

**Step 2: Update attemptAutoSetup to use dockerErrorMessage for notes**

When Docker check fails or auto-start fails, use the classified error type to show the right message.

**Step 3: Run full test suite**

Run: `npx vitest run src/docker/ src/wizard/mongodb-auto-setup.test.ts`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/docker/mongodb-docker.ts src/wizard/mongodb-auto-setup.ts
git commit -m "feat(docker): wire error classification into auto-start and wizard"
```

---

## Phase 4: Integration Testing & Polish

> **Exit Criteria:** Full test suite passes (existing + new tests). TSC clean. Build clean. The onboarding wizard auto-starts MongoDB on a clean system with Docker.

### Task 4.1: Full Integration Tests

**Files:**

- Modify: `src/docker/mongodb-docker.test.ts` — Add integration scenarios
- Run: Full test suite

**Step 1: Add end-to-end scenario tests**

```typescript
describe("integration: full auto-setup flow", () => {
  it("complete happy path: Docker available, fullstack starts, URI returned", async () => {
    // Mock the entire chain
    const { attemptAutoSetup } = await import("../wizard/mongodb-auto-setup.js");
    // ... (full mock chain)
  });

  it("complete fallback path: no Docker -> manual URI", async () => {
    // ...
  });

  it("complete reconnection path: containers already running", async () => {
    // ...
  });
});
```

**Step 2: Run full test suite**

Run: `npx vitest run src/memory/ src/wizard/ src/docker/ src/commands/doctor-memory-search.test.ts`
Expected: ALL PASS, zero regressions

**Step 3: Run TSC**

Run: `npx tsc --noEmit`
Expected: 0 new errors

**Step 4: Commit**

```bash
git add -A src/docker/ src/wizard/ src/commands/
git commit -m "test: add integration tests for zero-friction MongoDB onboarding"
```

---

### Task 4.2: Documentation Updates

**Files:**

- Modify: `docker/mongodb/README.md` — Add auto-setup section
- Modify: `CLAWMONGO_FRESH_START.md` — Update quickstart to mention auto-setup

**Step 1: Update README.md**

Add a section explaining that ClawMongo now auto-detects and starts MongoDB:

````markdown
## Automatic Setup (Recommended)

When you run the ClawMongo onboarding wizard, MongoDB is set up automatically:

1. The wizard detects if MongoDB is already running
2. If not, it checks for Docker and starts MongoDB via Docker Compose
3. It tries fullstack first (mongod + mongot), then falls back to simpler tiers
4. You never need to run Docker commands manually

Just run:

```bash
clawmongo onboard
```
````

If Docker is not available, the wizard falls back to asking for a MongoDB URI manually.

````

**Step 2: Update CLAWMONGO_FRESH_START.md**

Update the quickstart section to reflect that MongoDB is now automatic.

**Step 3: Commit**
```bash
git add docker/mongodb/README.md CLAWMONGO_FRESH_START.md
git commit -m "docs: update README and quickstart for auto-setup"
````

---

## Risk Assessment

| Risk                                      | P (1-5) | I (1-5) | Score | Mitigation                                             |
| ----------------------------------------- | ------- | ------- | ----- | ------------------------------------------------------ |
| Docker not installed on user's machine    | 3       | 3       | 9     | Clear install link + manual URI fallback               |
| Docker daemon not running                 | 3       | 2       | 6     | "Start Docker Desktop" message + manual fallback       |
| Image pull takes too long (slow network)  | 3       | 3       | 9     | Progress indicator + 2min timeout + manual fallback    |
| Port 27017 conflict with non-MongoDB      | 2       | 4       | 8     | Port detection BEFORE start + helpful message          |
| Docker Compose not available (old Docker) | 2       | 3       | 6     | Clear upgrade instructions + manual fallback           |
| All fallback tiers fail                   | 1       | 4       | 4     | Manual URI always available as last resort             |
| Permission errors on Docker socket        | 2       | 3       | 6     | Classified error with Linux docker group instructions  |
| Stale containers from previous runs       | 3       | 2       | 6     | `getRunningClawMongoContainers()` detects + reconnects |
| Network/volume conflicts                  | 1       | 3       | 3     | Classified errors with cleanup commands                |
| MongoDB driver not installed              | 2       | 4       | 8     | Dynamic import with try/catch, graceful fallback       |

---

## Success Criteria

- [ ] `clawmongo onboard` auto-starts MongoDB via Docker without user touching Docker
- [ ] Existing MongoDB at localhost:27017 is auto-detected and reused
- [ ] All Docker edge cases produce helpful, non-jargon error messages
- [ ] Manual URI fallback always works when Docker is unavailable
- [ ] Progress indicators show during image pulls and container startup
- [ ] Fallback tiers work: fullstack -> replicaset -> standalone
- [ ] All existing tests pass (449+ tests, zero regressions)
- [ ] TSC clean, build clean
- [ ] Works on macOS (primary), Linux, Windows

---

## Checkpoints (Decisions for BUILD)

- [CHECKPOINT] Should auto-setup run ONLY for `@romiluz/clawmongo` package, or also for upstream `openclaw`? **Recommend: ClawMongo only** (upstream users may not want Docker magic).
- [CHECKPOINT] Should images be pre-pulled before starting compose, or let compose pull? **Recommend: Let compose pull** (simpler, compose handles caching).
- [CHECKPOINT] Default connection URI for auto-started fullstack/replicaset: include auth credentials (`admin:admin`) or prompt for custom? **Recommend: Use defaults** (`admin:admin` for local dev, with env var override already in docker-compose).
- [CHECKPOINT] Should auto-started containers persist between sessions or be ephemeral? **Recommend: Persist** (named volumes in docker-compose already handle this; user data survives restarts).

---

## File Summary

### New Files

| File                                    | Purpose                                                                |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `src/docker/mongodb-docker.ts`          | Docker detection, compose orchestration, health checks, port detection |
| `src/docker/mongodb-docker.test.ts`     | Unit tests for Docker module                                           |
| `src/docker/docker-errors.ts`           | Error classification and user-friendly messages                        |
| `src/docker/docker-errors.test.ts`      | Tests for error classification                                         |
| `src/wizard/mongodb-auto-setup.ts`      | Auto-setup wizard orchestrator                                         |
| `src/wizard/mongodb-auto-setup.test.ts` | Tests for auto-setup wizard                                            |

### Modified Files

| File                                   | Change                                       |
| -------------------------------------- | -------------------------------------------- |
| `src/wizard/onboarding-memory.ts`      | Add auto-setup flow before manual URI prompt |
| `src/wizard/onboarding-memory.test.ts` | New tests for auto-setup integration         |
| `src/commands/configure-memory.ts`     | Add auto-setup to configure wizard           |
| `docker/mongodb/README.md`             | Document auto-setup feature                  |
| `CLAWMONGO_FRESH_START.md`             | Update quickstart section                    |

### Existing Files Used (Not Modified)

| File                                        | Usage                                                        |
| ------------------------------------------- | ------------------------------------------------------------ |
| `src/agents/sandbox/docker.ts`              | Import `execDocker`, `execDockerRaw`, `dockerContainerState` |
| `src/memory/mongodb-topology.ts`            | Import `detectTopology`, `topologyToTier` (after auto-start) |
| `docker/mongodb/docker-compose.mongodb.yml` | Driven by `startMongoDBCompose()`                            |
| `src/wizard/prompts.ts`                     | `WizardPrompter` interface for all UI                        |

---

## Confidence Score: 82/100

Factors:

- **Context References with file:line:** +25 (all key files referenced with line numbers)
- **Edge cases documented:** +18 (10 risks, 4 checkpoints, error classification)
- **Test commands specific:** +18 (TDD steps with exact vitest commands)
- **Risk mitigations defined:** +15 (every risk has a mitigation)
- **File paths exact:** +6 (all new/modified files listed)

Could improve to 90+ with:

- Real Docker E2E test script (not just unit tests with mocks)
- Windows-specific testing (Docker Desktop on Windows)
- Stress testing with slow networks

---

### Memory Notes (For Workflow-Final Persistence)

**Learnings:**

- Zero-friction DX plan: Docker auto-start with fallback tiers (fullstack->replicaset->standalone->manual URI->builtin). Every step has a fallback.
- Auto-setup should be ClawMongo-only (upstream openclaw users expect manual setup).
- Port conflict detection MUST happen before Docker start (not after).
- Error classification (docker-errors.ts) is critical for UX - raw Docker errors are cryptic.
- execDocker from sandbox/docker.ts is sufficient for all Docker operations - no new deps needed.
- Auto-setup orchestrator is a separate module (mongodb-auto-setup.ts) to keep onboarding-memory.ts clean.
- getComposeFilePath resolves relative to package root via import.meta.url - portable across installations.

**Patterns:**

- Docker detection: two-step (CLI installed -> daemon running), never auto-install or auto-start daemon.
- Health check polling: `docker inspect --format '{{.State.Health.Status}}'` with timeout and poll interval.
- Error classification pattern: regex patterns -> error type -> user-friendly message. Separates detection from messaging.
- Auto-setup result type: `{ success, uri?, tier?, source?, reason? }` - typed union enables clean branching.
- Module layout: `src/docker/` for Docker utilities, separate from `src/agents/sandbox/docker.ts` which is sandbox-specific.

**Verification:**

- Plan: `docs/plans/2026-02-16-zero-friction-mongodb-onboarding-plan.md` with 82/100 confidence
- 4 phases, 10 risks identified, 4 checkpoints
- 6 new files + 5 modified files
- TDD approach with exact test/implementation steps
