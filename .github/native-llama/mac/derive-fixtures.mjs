import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export function deriveFixtures(source) {
  const read = (name) => fs.readFileSync(path.join(source, name), "utf8");
  const llama = JSON.parse(read("extensions/llama-cpp/openclaw.plugin.json"));
  const ollama = JSON.parse(read("extensions/ollama/openclaw.plugin.json"));
  const choices = [
    llama.providerAuthChoices.find((choice) => choice.choiceId === "llama-app"),
    llama.providerAuthChoices.find((choice) => choice.choiceId === "llama-cpp"),
    llama.providerAuthChoices.find((choice) => choice.choiceId === "llama-cpp-existing-server"),
    ollama.providerAuthChoices.find((choice) => choice.choiceId === "ollama"),
  ];
  assert(choices.every(Boolean));
  const options = choices.map((choice) => {
    assert.equal(choice.appGuidedDiscovery, true);
    assert.equal(choice.appGuidedActionLabel, "Set up");
    return { id: choice.choiceId, brandId: choice.provider, label: choice.choiceLabel,
      hint: choice.choiceHint, actionLabel: choice.appGuidedActionLabel,
      ...(choice.website ? { website: choice.website } : {}),
      ...(choice.icon ? { icon: choice.icon } : {}) };
  });
  const registration = read("extensions/llama-cpp/src/external-server/registration.ts");
  const quoted = String.raw`("(?:[^"\\]|\\.)*")`;
  const noteCall = registration.match(new RegExp(String.raw`ctx\.prompter\.note\(\s*${quoted},\s*${quoted},?\s*\)`));
  assert(noteCall, "Pinned provider note contract changed");
  const defaults = read("extensions/llama-cpp/src/external-server/defaults.ts");
  const appBlock = defaults.match(/export const LLAMA_APP_SERVER[^=]*= \{([\s\S]*?)\};/);
  assert(appBlock);
  const field = (name) => { const match = appBlock[1].match(new RegExp(name + ":\\s*" + quoted)); assert(match); return JSON.parse(match[1]); };
  const label = field("label");
  assert.equal(label, options[0].label);
  const setup = read("extensions/llama-cpp/src/external-server/setup.ts");
  assert(setup.includes("message: " + String.fromCharCode(96) + "${server.label} URL" + String.fromCharCode(96)));
  return {
    "detect.json": { candidates: [{ kind: "existing-model", label: "Existing model",
      detail: "Saved default (synthetic fixture; not tested)", modelRef: "fixture-existing/model",
      recommended: false, credentials: true }], unavailableCandidates: [],
      manualProviders: [{ id: "openai-api-key", brandId: "openai", label: "OpenAI API key" }],
      authOptions: [], prepareOptions: options, workspace: "/synthetic-workspace", configuredModel: "fixture-existing/model", setupComplete: false },
    "install-note.json": { done: false, status: "running", step: { id: "llama-install-note",
      type: "note", executor: "client", title: JSON.parse(noteCall[2]), message: JSON.parse(noteCall[1]) } },
    "endpoint.json": { done: false, status: "running", step: { id: "llama-url", type: "text",
      executor: "client", message: `${label} URL`, placeholder: field("defaultOrigin") } },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, output] = process.argv.slice(2);
  assert(source && output);
  fs.mkdirSync(output, { recursive: true });
  const fixtures = deriveFixtures(source);
  for (const [name, value] of Object.entries(fixtures)) fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
  console.log(JSON.stringify({ status: "DERIVED", choices: fixtures["detect.json"].prepareOptions.map((choice) => choice.id) }));
}
