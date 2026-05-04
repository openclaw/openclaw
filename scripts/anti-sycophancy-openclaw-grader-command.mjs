#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import process from "node:process";

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim().startsWith("{")) {
    return JSON.parse(fenced[1].trim());
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("no JSON object found in grader output");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function extractAgentReply(rawOutput) {
  const parsed = extractJsonObject(rawOutput);
  const candidates = [
    parsed.reply,
    parsed.message,
    parsed.output,
    parsed.text,
    parsed.content,
    parsed.payloads?.find((payload) => typeof payload?.text === "string" && payload.text.trim())
      ?.text,
    parsed.meta?.finalAssistantVisibleText,
    parsed.meta?.finalAssistantRawText,
    parsed.result?.reply,
    parsed.result?.message,
    parsed.result?.output,
    parsed.result?.text,
    parsed.result?.payloads?.find(
      (payload) => typeof payload?.text === "string" && payload.text.trim(),
    )?.text,
    parsed.result?.meta?.finalAssistantVisibleText,
    parsed.result?.meta?.finalAssistantRawText,
    parsed.assistant?.message,
    parsed.assistant?.content,
  ];
  const reply = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  if (!reply) {
    throw new Error("could not find grader reply in OpenClaw JSON output");
  }
  return reply.trim();
}

const prompt = (await readStdin()).trim();
if (!prompt) {
  throw new Error("grader prompt is required on stdin");
}

const openclawBin = argValue("--openclaw-bin", process.env.OPENCLAW_BIN || "openclaw");
const agent = argValue("--agent", process.env.ANTI_SYCOPHANCY_GRADER_AGENT || "rex");
const model = argValue("--model", process.env.ANTI_SYCOPHANCY_GRADER_MODEL || "");
const timeoutSeconds = Number(
  argValue("--timeout", process.env.ANTI_SYCOPHANCY_GRADER_TIMEOUT || "180"),
);
const local = !hasFlag("--gateway");

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  throw new Error("--timeout must be a positive number of seconds");
}

const args = ["agent"];
if (local) {
  args.push("--local");
}
args.push(
  "--agent",
  agent,
  "--session-id",
  `anti-sycophancy-grader-command-${Date.now()}`,
  "--message",
  prompt,
  "--json",
  "--timeout",
  String(timeoutSeconds),
);
if (model) {
  args.push("--model", model);
}

const raw = execFileSync(openclawBin, args, {
  encoding: "utf8",
  env: process.env,
  maxBuffer: 1024 * 1024 * 8,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: (timeoutSeconds + 30) * 1000,
});

process.stdout.write(`${JSON.stringify(extractJsonObject(extractAgentReply(raw)))}\n`);
