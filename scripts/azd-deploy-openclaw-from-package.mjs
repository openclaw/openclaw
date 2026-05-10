#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const WINDOWS_COMMANDS = {
  az: "az.cmd",
  azd: "azd.exe",
  docker: "docker.exe",
};

function usage() {
  return [
    "Usage: node scripts/azd-deploy-openclaw-from-package.mjs [--tag <tag>] [--dry-run]",
    "",
    "Builds the root OpenClaw Docker image locally, pushes it to the current azd",
    "environment's Azure Container Registry, then deploys with `azd deploy openclaw --from-package`.",
  ].join("\n");
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    tag: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--tag") {
      options.tag = argv[(index += 1)] ?? "";
      if (!options.tag) {
        fail("missing value for --tag\n" + usage());
      }
      continue;
    }

    if (arg.startsWith("--tag=")) {
      options.tag = arg.slice("--tag=".length);
      if (!options.tag) {
        fail("missing value for --tag\n" + usage());
      }
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage() + "\n");
      process.exit(0);
    }

    fail(`unknown argument: ${arg}\n${usage()}`);
  }

  return options;
}

function unquoteValue(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

function parseEnvValues(output) {
  const values = {};
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    values[key] = unquoteValue(value);
  }
  return values;
}

function stripImageTag(imageRef) {
  const lastSlash = imageRef.lastIndexOf("/");
  const lastColon = imageRef.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return imageRef.slice(0, lastColon);
  }
  return imageRef;
}

function quoteArg(arg) {
  if (/^[A-Za-z0-9_./:=@-]+$/u.test(arg)) {
    return arg;
  }
  return JSON.stringify(arg);
}

function resolveCommand(command) {
  if (process.platform !== "win32") {
    return command;
  }

  return WINDOWS_COMMANDS[command] ?? command;
}

function shellQuoteForCmd(arg) {
  if (/^[A-Za-z0-9_./:=@-]+$/u.test(arg)) {
    return arg;
  }

  return `"${String(arg).replace(/"/gu, '""')}"`;
}

function runCapture(command, args) {
  return execFileSync(resolveCommand(command), args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function runStep(step, options) {
  const command = resolveCommand(step.command);
  const env = {
    ...process.env,
    ...step.env,
  };

  const renderedCommand = [command, ...step.args].map(quoteArg).join(" ");
  console.error(`==> ${step.label}`);
  console.error(`    ${renderedCommand}`);

  if (options.dryRun) {
    return;
  }

  const isWindowsCmd = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
  const result = isWindowsCmd
    ? spawnSync(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", [command, ...step.args].map(shellQuoteForCmd).join(" ")],
        {
          cwd: ROOT_DIR,
          env,
          stdio: "inherit",
        },
      )
    : spawnSync(command, step.args, {
        cwd: ROOT_DIR,
        env,
        stdio: "inherit",
      });

  if (typeof result.status === "number" && result.status === 0) {
    return;
  }

  if (result.error) {
    throw result.error;
  }

  throw new Error(`${command} failed with ${result.status ?? result.signal ?? "unknown status"}`);
}

function requiredEnv(values, key) {
  const value = values[key]?.trim();
  if (!value) {
    fail(`missing ${key} in azd env values`);
  }
  return value;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const envValues = parseEnvValues(runCapture("azd", ["env", "get-values"]));
  const registry = requiredEnv(envValues, "AZURE_CONTAINER_REGISTRY_ENDPOINT");
  const serviceImageName = requiredEnv(envValues, "SERVICE_OPENCLAW_IMAGE_NAME");
  const subscriptionId = envValues.AZURE_SUBSCRIPTION_ID?.trim() || "";
  const environmentName = envValues.AZURE_ENV_NAME?.trim() || "unknown";
  const acrName = registry.split(".")[0];
  const repositoryPath = stripImageTag(serviceImageName).replace(`${registry}/`, "");
  const tag = options.tag || `azd-deploy-${Math.floor(Date.now() / 1000)}`;
  const imageRef = `${registry}/${repositoryPath}:${tag}`;
  const azArgs = subscriptionId ? ["--subscription", subscriptionId] : [];

  console.error(`==> Using azd environment ${environmentName}`);
  console.error(`==> Target image ${imageRef}`);

  const steps = [
    {
      label: `Login to ACR ${acrName}`,
      command: "az",
      args: ["acr", "login", "--name", acrName, ...azArgs],
    },
    {
      label: `Build ${imageRef}`,
      command: "docker",
      args: ["build", "-f", "Dockerfile", "--platform", "linux/amd64", "-t", imageRef, "."],
      env: {
        DOCKER_BUILDKIT: "1",
      },
    },
    {
      label: `Push ${imageRef}`,
      command: "docker",
      args: ["push", imageRef],
    },
    {
      label: `Deploy openclaw from ${imageRef}`,
      command: "azd",
      args: ["deploy", "openclaw", "--from-package", imageRef, "--no-prompt"],
    },
  ];

  for (const step of steps) {
    runStep(step, options);
  }

  if (!options.dryRun) {
    console.log(imageRef);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
