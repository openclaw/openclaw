import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  readWorkspaceSkillResources,
  resolveWorkspaceWorkerArgv,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import { canonicalPathFromExistingAncestor } from "openclaw/plugin-sdk/security-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { evaluateFileReadPolicySnapshot } from "../shared/policy.js";
import { readWorkspaceMemoryRequest } from "../shared/workspace-memory-request.js";
import { readWorkspaceSkillsRequest } from "../shared/workspace-skills-request.js";
import { prepareSkillSource, retireSkillSource } from "./workspace-skill-source.js";

/** Run the same packaged file worker used by SSH adapters; never run arbitrary argv. */
export function createWorkspaceCommand(
  api: OpenClawPluginApi,
  kind: "memory" | "skills",
): OpenClawPluginNodeHostCommand {
  return {
    command: `workspace.${kind}`,
    cap: "file",
    dangerous: true,
    duplex: true,
    async handle(paramsJSON, io) {
      if (!io?.frames) {
        throw new Error("Workspace workers require node duplex transport");
      }
      const params = JSON.parse(paramsJSON ?? "{}");
      const skillRequest = kind === "skills" ? readWorkspaceSkillsRequest(params) : undefined;
      const request = skillRequest ?? readWorkspaceMemoryRequest(params);
      const maxReplyBytes = params.maxReplyBytes;
      if (
        maxReplyBytes !== undefined &&
        (!Number.isSafeInteger(maxReplyBytes) || maxReplyBytes < 0)
      ) {
        throw new Error("Invalid workspace response byte limit");
      }
      const agents = listAgentIds(api.config);
      const configured = agents.some(
        (agentId) =>
          path.resolve(api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId)) ===
          request.workspaceDir,
      );
      if (!configured) {
        throw new Error("Workspace does not belong to this node");
      }
      // Keep the existing file-node no-alias policy; native Memory still owns file IO.
      for (const access of request.paths) {
        if ((await canonicalPathFromExistingAncestor(access.path)) !== access.path) {
          throw new Error("Node workspace paths must use their canonical location");
        }
      }
      io.signal.throwIfAborted();
      const interactive =
        kind === "skills" && ["applyRoot", "removeSkill"].includes(params.operation);
      let childInput: Writable | undefined;
      let hasStarted = false;
      let source: Awaited<ReturnType<typeof prepareSkillSource>> | undefined;
      const started = createDeferred<void>();
      const unsubscribe = io.frames.onMessage((message) => {
        if (io.signal.aborted) {
          return;
        }
        if (!hasStarted && Buffer.from(message).toString("utf8") === "start") {
          hasStarted = true;
          started.resolve();
          return;
        }
        if (!interactive || !childInput || message.byteLength > 1024 * 1024) {
          throw new Error("Unexpected workspace worker input");
        }
        const decision = asOptionalRecord(JSON.parse(Buffer.from(message).toString("utf8")));
        if (!decision || !("decision" in decision)) {
          throw new Error("Expected a Gateway Skill policy decision");
        }
        childInput.write(`${JSON.stringify(decision)}\n`);
      });
      const abortStart = () => started.resolve();
      io.signal.addEventListener("abort", abortStart, { once: true });
      try {
        await started.promise;
        io.signal.throwIfAborted();
        let workerRequest = request.request;
        if (kind === "skills" && params.operation === "applyRoot") {
          const input = JSON.parse(request.request);
          source = await prepareSkillSource(request.workspaceDir, input.sourceArchive);
          const { sourceArchive: _archive, ...files } = input;
          workerRequest = JSON.stringify({
            ...files,
            extractedRoot: source.extractedRoot,
            publicationCheckpoints: true,
          });
        }
        if (kind === "skills" && params.operation === "readResources") {
          const assertFileAccess = createSkillFileAccessAssertion(
            params.resourceReadPolicy,
            io.signal,
          );
          // SAFETY: The same-version adapter sends the native Skill; request admission checked its root.
          const input = JSON.parse(request.request) as {
            skill: Parameters<typeof readWorkspaceSkillResources>[0];
            allowMissingRoot: boolean;
          };
          const files = await readWorkspaceSkillResources(input.skill, {
            allowMissingRoot: input.allowMissingRoot,
            assertFileAccess,
          });
          const bytes = Buffer.from(`${JSON.stringify(files)}\n`);
          if (maxReplyBytes !== undefined && bytes.byteLength > maxReplyBytes) {
            throw new Error("Workspace response exceeds the node file policy byte limit");
          }
          io.signal.throwIfAborted();
          await io.frames.send(bytes);
          return JSON.stringify({ ok: true });
        }
        const child = spawn(
          process.execPath,
          [
            ...resolveWorkspaceWorkerArgv(kind),
            ...(skillRequest
              ? [request.workspaceDir, os.homedir(), skillRequest.operation]
              : [request.watch ? "--watch-files" : "--files", request.workspaceDir]),
          ],
          {
            cwd: request.workspaceDir,
            env: { HOME: os.homedir(), PATH: process.env.PATH },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`Workspace worker exited with ${code}`)),
          );
        });
        void exited.catch(() => {});
        child.stderr.on("data", (bytes: Buffer) =>
          api.logger.warn(bytes.toString("utf8").trimEnd()),
        );
        const allowRollback = kind === "skills" && params.operation === "applyRoot";
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return;
          }
          if (allowRollback) {
            // EOF refuses pending publication checkpoints. The native installer
            // must restore its displaced target before we terminate the worker.
            child.stdin.end();
            stopTimer ??= setTimeout(() => child.kill("SIGKILL"), 30_000);
            stopTimer.unref();
          } else {
            child.kill("SIGTERM");
          }
        };
        child.stdin.on("error", stop);
        io.signal.addEventListener("abort", stop, { once: true });
        try {
          io.signal.throwIfAborted();
          childInput = child.stdin;
          if (request.watch || interactive) {
            child.stdin.write(`${workerRequest.trimEnd()}\n`);
          } else {
            child.stdin.end(workerRequest);
          }
          const discoveryChunks: Buffer[] | undefined =
            kind === "skills" && params.operation === "discovery" ? [] : undefined;
          const replyLimit = discoveryChunks ? (maxReplyBytes ?? 100 * 1024 * 1024) : maxReplyBytes;
          let bytesSent = 0;
          for await (const bytes of child.stdout.iterator({ destroyOnReturn: false })) {
            if (allowRollback && io.signal.aborted) {
              continue;
            }
            io.signal.throwIfAborted();
            bytesSent += bytes.byteLength;
            if (!request.watch && replyLimit !== undefined && bytesSent > replyLimit) {
              throw new Error("Workspace response exceeds the node file policy byte limit");
            }
            if (discoveryChunks) {
              discoveryChunks.push(bytes);
            } else {
              await io.frames.send(bytes);
            }
          }
          await exited;
          io.signal.throwIfAborted();
          if (discoveryChunks) {
            const bytes = Buffer.concat(discoveryChunks, bytesSent);
            const sources = asOptionalRecord(JSON.parse(bytes.toString("utf8")));
            const assertFileAccess = createSkillFileAccessAssertion(
              params.resourceReadPolicy,
              io.signal,
            );
            for (const key of ["entries", "executionEntries"] as const) {
              const entries = sources?.[key];
              if (!Array.isArray(entries)) {
                throw new Error("Invalid Skill discovery result");
              }
              for (const entry of entries) {
                const filePath = asOptionalRecord(asOptionalRecord(entry)?.skill)?.filePath;
                if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
                  throw new Error("Invalid Skill discovery file path");
                }
                assertFileAccess(filePath, await fs.realpath(filePath));
              }
            }
            const statusFiles = asOptionalRecord(sources?.status)?.files;
            if (Array.isArray(statusFiles)) {
              for (const file of statusFiles) {
                const card = asOptionalRecord(asOptionalRecord(file)?.skillCard);
                if (typeof card?.content !== "string") {
                  continue;
                }
                const cardPath = card.path;
                if (typeof cardPath !== "string" || !path.isAbsolute(cardPath)) {
                  throw new Error("Invalid Skill card file path");
                }
                assertFileAccess(cardPath, await fs.realpath(cardPath));
              }
            }
            // Reject the whole result before any metadata or derived status crosses the boundary.
            io.signal.throwIfAborted();
            await io.frames.send(bytes);
          }
          return JSON.stringify({ ok: true });
        } finally {
          io.signal.removeEventListener("abort", stop);
          childInput = undefined;
          stop();
          // Also drain when frame delivery fails: closing stdout can interrupt
          // the installer's failure response before rollback has settled.
          child.stdout.resume();
          await exited.catch(() => {});
          clearTimeout(stopTimer);
          child.stdin.destroy();
        }
      } finally {
        io.signal.removeEventListener("abort", abortStart);
        unsubscribe();
        try {
          await source?.cleanup();
        } finally {
          if (kind === "skills" && params.operation === "applyRoot") {
            await retireSkillSource(
              request.workspaceDir,
              JSON.parse(request.request).sourceArchive,
            );
          }
        }
      }
    },
  };
}

function createSkillFileAccessAssertion(input: unknown, signal: AbortSignal) {
  const policy = asOptionalRecord(input);
  const pluginConfig = asOptionalRecord(policy?.pluginConfig);
  if (typeof policy?.nodeId !== "string" || !pluginConfig) {
    throw new Error("Skill access requires a Gateway file read policy");
  }
  const nodeId = policy.nodeId;
  return (requestedPath: string, canonicalPath: string) => {
    signal.throwIfAborted();
    for (const filePath of new Set([requestedPath, canonicalPath])) {
      const decision = evaluateFileReadPolicySnapshot({ nodeId, pluginConfig, path: filePath });
      if (
        !decision.ok ||
        decision.reason === "ask-always" ||
        (!decision.followSymlinks && requestedPath !== canonicalPath)
      ) {
        throw new Error("Skill resource is denied by the node file read policy");
      }
    }
  };
}
