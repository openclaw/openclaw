import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Receipts cross jobs in the same workflow through needs.<job>.outputs. Never
// export the Crabbox claim: it contains SSH access and local workspace state.
const [command, role] = process.argv.slice(2);
if (
  !["provision", "register", "cleanup"].includes(command) ||
  !["decision", "drain", "nightly"].includes(role)
) {
  throw new Error(
    "Usage: boat-release-runner.mjs provision|register|cleanup decision|drain|nightly",
  );
}
const env = process.env;
for (const name of [
  "GITHUB_REPOSITORY",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "RUNNER_TEMP",
]) {
  if (!env[name]) {
    throw new Error(`Missing ${name}`);
  }
}
const org = env.GITHUB_REPOSITORY.split("/")[0];
const identity = [
  env.GITHUB_REPOSITORY,
  env.GITHUB_WORKFLOW_REF,
  env.GITHUB_RUN_ID,
  env.GITHUB_RUN_ATTEMPT,
  role,
].join("\n");
const hash = createHash("sha256").update(identity).digest("hex");
const leaseID = `cbx_${hash.slice(0, 12)}`;
const label = `release-${role}-${hash.slice(0, 20)}`;
const receiptPath = join(env.RUNNER_TEMP, `boat-${role}-runner.json`);
const crabbox = env.CRABBOX_BIN || "crabbox";
const providerArgs = [
  "--provider",
  "ascii-box",
  "--ascii-box-cli",
  "boat",
  "--ascii-box-base-url",
  "https://boat.dev",
  "--ascii-box-no-env",
];
const childEnv = {
  ...env,
  BOX_ORG: env.BOAT_ORG,
  CRABBOX_ASCII_BOX_API_KEY: env.BOAT_API_KEY,
  CRABBOX_ASCII_BOX_CLI: "boat",
  CRABBOX_ASCII_BOX_BASE_URL: "https://boat.dev",
  CRABBOX_MAX_TTL: "24h",
  BOAT_NO_UPDATE: "1",
};

function run(binary, args, timeout, input) {
  // Provider diagnostics can include private connection URLs. Report the phase
  // and exit code here; never put captured stdout/stderr in Actions logs.
  return spawnSync(binary, args, {
    env: childEnv,
    input,
    encoding: "utf8",
    timeout: timeout ?? 180_000,
    maxBuffer: 1024 * 1024,
  });
}
function checked(binary, args, timeout) {
  const result = run(binary, args, timeout);
  if (result.error || result.status !== 0) {
    throw new Error(
      `${binary} ${args[0]} failed (${result.error?.code || result.status}); cleanup receipts are retained.`,
    );
  }
  return result.stdout;
}
function output(name, value) {
  if (!env.GITHUB_OUTPUT) {
    throw new Error("Missing GITHUB_OUTPUT");
  }
  appendFileSync(
    env.GITHUB_OUTPUT,
    `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
  );
}
function vmReceipt(text) {
  const receipt = JSON.parse(text);
  if (
    !receipt ||
    Object.keys(receipt).toSorted().join(",") !== "createdAt,id,leaseID" ||
    receipt.leaseID !== leaseID ||
    !/^bx_[A-Za-z0-9_-]+$/.test(receipt.id) ||
    !Number.isFinite(Date.parse(receipt.createdAt))
  ) {
    throw new Error("Boat VM receipt does not match this workflow job.");
  }
  return receipt;
}
function runnerReceipt(text) {
  const receipt = JSON.parse(text);
  const fields = receipt && Object.keys(receipt).toSorted().join(",");
  if (
    fields !== "leaseID,name,runnerID,scope,version" ||
    receipt.version !== 1 ||
    receipt.leaseID !== leaseID ||
    receipt.scope !== `orgs/${org}` ||
    receipt.name !== label ||
    !Number.isSafeInteger(receipt.runnerID) ||
    receipt.runnerID <= 0
  ) {
    throw new Error("Actions runner receipt does not match this workflow job.");
  }
  return receipt;
}

if (command === "provision") {
  if (!env.BOAT_API_KEY || !env.BOAT_ORG) {
    throw new Error("Set BOAT_API_KEY and BOAT_ORG before provisioning.");
  }
  if (!env.BOAT_RUNNER_GROUP) {
    throw new Error("Set the release organization runner group before provisioning.");
  }
  const help = run(crabbox, ["actions", "register", "--help"]);
  if (help.error || help.status !== 0 || !`${help.stdout}\n${help.stderr}`.includes("--receipt")) {
    throw new Error(
      "Install a Crabbox release with portable Actions cleanup receipts before provisioning.",
    );
  }
  const acquired = run(
    crabbox,
    [
      "warmup",
      ...providerArgs,
      "--lease-id",
      leaseID,
      "--slug",
      label,
      "--class",
      "standard",
      "--type",
      "default",
      "--arch",
      "amd64",
      "--target",
      "linux",
      "--network",
      "public",
      "--tailscale=false",
      "--ttl",
      "24h",
      "--idle-timeout",
      "24h",
      "--keep",
    ],
    15 * 60_000,
  );
  // A failed warmup may already own a VM. Publish only its public identity before
  // propagating the failure, so an always() cleanup job can still remove it.
  const inspected = run(crabbox, ["inspect", "--provider", "ascii-box", "--id", leaseID, "--json"]);
  if (!inspected.error && inspected.status === 0) {
    const status = JSON.parse(inspected.stdout);
    const receipt = vmReceipt(
      JSON.stringify({
        leaseID,
        id: status.serverId,
        createdAt: status.labels?.ascii_box_created_at,
      }),
    );
    output("vm", receipt);
    // Twelve hours of work plus setup and queueing must fit the actual provider
    // deadline. A requested TTL does not prove the plan accepted it.
    const expires =
      typeof status.expiresAt === "string" && /^\d+$/.test(status.expiresAt)
        ? Number(status.expiresAt)
        : Date.parse(status.expiresAt);
    if (!Number.isFinite(expires) || expires - Date.now() < 13 * 60 * 60_000) {
      throw new Error("Boat granted less than thirteen hours; runner was not registered.");
    }
  } else {
    throw new Error("Boat VM identity is unconfirmed; inspect the task lease before retrying.");
  }
  if (acquired.error || acquired.status !== 0) {
    throw new Error("Boat warmup failed after acquiring its VM; cleanup is required.");
  }
} else if (command === "register") {
  vmReceipt(env.BOAT_VM_RECEIPT || "null");
  if (!env.BOAT_RUNNER_GROUP) {
    throw new Error("Set the release organization runner group before registering.");
  }
  const result = run(
    crabbox,
    [
      "actions",
      "register",
      ...providerArgs,
      "--id",
      leaseID,
      "--org",
      org,
      "--runner-group",
      env.BOAT_RUNNER_GROUP,
      "--name",
      label,
      "--labels",
      label,
      "--ephemeral",
      "--receipt",
      receiptPath,
    ],
    5 * 60_000,
  );
  if (existsSync(receiptPath)) {
    output("runner", runnerReceipt(readFileSync(receiptPath, "utf8")));
  }
  if (result.error || result.status !== 0) {
    throw new Error("Boat runner registration failed; cleanup is required.");
  }
  if (!existsSync(receiptPath)) {
    throw new Error("Crabbox did not publish an Actions cleanup receipt.");
  }
  output("label", label);
} else {
  const failures = [];
  if (env.BOAT_RUNNER_RECEIPT) {
    try {
      writeFileSync(receiptPath, JSON.stringify(runnerReceipt(env.BOAT_RUNNER_RECEIPT)), {
        mode: 0o600,
      });
      checked(crabbox, ["actions", "unregister", "--receipt", receiptPath]);
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (env.BOAT_VM_RECEIPT) {
    try {
      const receipt = vmReceipt(env.BOAT_VM_RECEIPT);
      if (!env.BOAT_API_KEY || !env.BOAT_ORG) {
        throw new Error("Missing Boat cleanup credentials.");
      }
      const login = run(
        "boat",
        ["--no-update", "--json", "login", "--key-stdin"],
        60_000,
        env.BOAT_API_KEY,
      );
      if (login.error || login.status !== 0) {
        throw new Error("Boat cleanup authentication failed.");
      }
      const actual = JSON.parse(
        checked("boat", ["--no-update", "--json", "info", receipt.id]),
      ).sandbox;
      if (
        actual?.id !== receipt.id ||
        !Number.isFinite(Date.parse(actual.createdAt)) ||
        Math.abs(Date.parse(actual.createdAt) - Date.parse(receipt.createdAt)) > 5000
      ) {
        throw new Error("Boat VM creation identity changed; refusing deletion.");
      }
      const result = run("boat", ["--no-update", "--json", "delete", receipt.id, "--yes"]);
      let operation;
      try {
        operation = JSON.parse(result.stdout).operation;
      } catch {
        /* Report unconfirmed deletion below. */
      }
      if (
        !operation ||
        !/^bdop_[a-f0-9]{32}$/.test(operation.id) ||
        operation.targetId !== receipt.id ||
        !["box", "sandbox"].includes(operation.kind)
      ) {
        throw new Error(
          `Boat deletion is unconfirmed for ${receipt.id}; reconcile before retrying.`,
        );
      }
      if (
        result.error ||
        result.status !== 0 ||
        operation.status !== "completed" ||
        !Number.isFinite(Date.parse(operation.completedAt))
      ) {
        throw new Error(
          `Boat deletion ${operation.id} is not confirmed complete; inspect it with boat deletion status.`,
        );
      }
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (failures.length) {
    throw new Error(failures.join("\n"));
  }
}
