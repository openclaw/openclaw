import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { downloadModel, verifyModel } from "./artifacts.js";
import { findModel, MODELS } from "./catalog.js";
import type { WorkerConfig } from "./config.js";
import { createOnnxProvider } from "./decisions.js";
import { InferenceWorkerClient } from "./worker-client.js";

type CliContext = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0];

export function registerOnnxCli(
  { program }: CliContext,
  settings: WorkerConfig,
  workerUrl: URL,
  resolvePath: (value: string) => string,
): void {
  const root = program
    .command("onnx")
    .description("Download, verify, and probe local ONNX decision models");
  const config = (options: { modelDir?: string }) => ({
    ...settings,
    ...(options.modelDir === undefined
      ? {}
      : { modelDir: path.resolve(resolvePath(options.modelDir)) }),
  });
  const model = (id: string) => {
    const found = findModel(id);
    if (!found) {
      throw new Error(`Unknown ONNX model '${id}'. Run openclaw onnx models.`);
    }
    return found;
  };
  root
    .command("models")
    .description("List supported classifiers and artifact sources")
    .action(() => {
      console.log(
        JSON.stringify(
          MODELS.map((entry) => ({
            id: entry.id,
            name: entry.name,
            source: entry.source.kind,
            repository: entry.source.repository,
            revision: entry.source.revision,
            maxTokens: entry.maxTokens,
            downloadBytes:
              entry.source.kind === "hub"
                ? entry.source.files.reduce((sum, file) => sum + file.bytes, 0)
                : undefined,
          })),
          null,
          2,
        ),
      );
    });
  root
    .command("download")
    .argument("<model>")
    .option("--model-dir <path>", "Override the model artifact directory")
    .description("Download revision-pinned artifacts and verify their SHA256 hashes")
    .action(async (id: string, options: { modelDir?: string }) => {
      const selected = model(id);
      const modelSettings = config(options);
      await downloadModel(modelSettings.modelDir, selected, AbortSignal.timeout(30 * 60_000));
      console.log(`Verified ${selected.id} in ${path.join(modelSettings.modelDir, selected.id)}`);
    });
  root
    .command("verify")
    .argument("<model>")
    .option("--model-dir <path>", "Override the model artifact directory")
    .description("Verify model artifacts without loading native inference")
    .action(async (id: string, options: { modelDir?: string }) => {
      await verifyModel(config(options).modelDir, model(id));
      console.log(`Verified ${id}`);
    });
  root
    .command("probe")
    .argument("<model>")
    .option("--model-dir <path>", "Override the model artifact directory")
    .description("Run a fixed local Choice, Score, and Boolean smoke evaluation")
    .action(async (id: string, options: { modelDir?: string }) => {
      model(id);
      const client = new InferenceWorkerClient({ workerUrl, config: config(options) });
      try {
        const start = performance.now();
        await client.warm([id], AbortSignal.timeout(120_000));
        const warmed = performance.now();
        const timeoutMs = 30_000;
        const signal = AbortSignal.timeout(timeoutMs);
        const outcome = await createOnnxProvider(client, (message) =>
          console.error(message),
        ).evaluate(
          {
            state: "I loved the quiet beach holiday and would happily go back.",
            questions: {
              topic: {
                type: "choice",
                criteria: {
                  travel: "travel and holidays",
                  finance: "finance and banking",
                  science: "scientific research",
                },
              },
              sentiment: {
                type: "score",
                criteria: ["negative sentiment", "neutral sentiment", "positive sentiment"],
              },
              holiday: {
                type: "boolean",
                criteria: {
                  true: "The text describes a holiday",
                  false: "The text is unrelated to holidays",
                },
              },
            },
          },
          { model: id, signal, deadlineMonotonicMs: warmed + timeoutMs },
        );
        console.log(
          JSON.stringify(
            {
              model: id,
              warmupMs: warmed - start,
              inferenceMs: performance.now() - warmed,
              outcome,
            },
            null,
            2,
          ),
        );
        if (outcome.status !== "ok") {
          throw new Error(`ONNX probe failed: ${outcome.reason}`);
        }
      } finally {
        await client.stop();
      }
    });
}
