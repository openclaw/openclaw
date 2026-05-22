import path from "node:path";
import fs from "node:fs/promises";
import { expect, vi } from "vitest";
//#region src/cli/test-runtime-capture.ts
function normalizeRuntimeStdout(value) {
	return value.endsWith("\n") ? value.slice(0, -1) : value;
}
function stringifyRuntimeJson(value, space = 2) {
	return JSON.stringify(value, null, space > 0 ? space : void 0);
}
function createCliRuntimeCapture() {
	const runtimeLogs = [];
	const runtimeErrors = [];
	const stringifyArgs = (args) => args.map((value) => String(value)).join(" ");
	const defaultRuntime = {
		log: vi.fn((...args) => {
			runtimeLogs.push(stringifyArgs(args));
		}),
		error: vi.fn((...args) => {
			runtimeErrors.push(stringifyArgs(args));
		}),
		writeStdout: vi.fn((value) => {
			defaultRuntime.log(normalizeRuntimeStdout(value));
		}),
		writeJson: vi.fn((value, space = 2) => {
			defaultRuntime.log(stringifyRuntimeJson(value, space));
		}),
		exit: vi.fn((code) => {
			throw new Error(`__exit__:${code}`);
		})
	};
	return {
		runtimeLogs,
		runtimeErrors,
		defaultRuntime,
		resetRuntimeCapture: () => {
			runtimeLogs.length = 0;
			runtimeErrors.length = 0;
		}
	};
}
function spyRuntimeLogs(runtime) {
	return vi.spyOn(runtime, "log").mockImplementation(() => {});
}
function spyRuntimeErrors(runtime) {
	return vi.spyOn(runtime, "error").mockImplementation(() => {});
}
function spyRuntimeJson(runtime) {
	return vi.spyOn(runtime, "writeJson").mockImplementation(() => {});
}
function firstWrittenJsonArg(writeJson) {
	return writeJson.mock.calls.at(0)?.[0] ?? null;
}
//#endregion
//#region src/agents/sandbox/test-fixtures.ts
function createSandboxTestContext(params) {
	const overrides = params?.overrides ?? {};
	const { docker: _unusedDockerOverrides, ...sandboxOverrides } = overrides;
	const docker = {
		image: "openclaw-sandbox:bookworm-slim",
		containerPrefix: "openclaw-sbx-",
		network: "none",
		user: "1000:1000",
		workdir: "/workspace",
		readOnlyRoot: false,
		tmpfs: [],
		capDrop: [],
		seccompProfile: "",
		apparmorProfile: "",
		setupCommand: "",
		binds: [],
		dns: [],
		extraHosts: [],
		pidsLimit: 0,
		...overrides.docker,
		...params?.dockerOverrides
	};
	return {
		enabled: true,
		backendId: "docker",
		sessionKey: "sandbox:test",
		workspaceDir: "/tmp/workspace",
		agentWorkspaceDir: "/tmp/workspace",
		workspaceAccess: "rw",
		runtimeId: "openclaw-sbx-test",
		runtimeLabel: "openclaw-sbx-test",
		containerName: "openclaw-sbx-test",
		containerWorkdir: "/workspace",
		tools: {
			allow: ["*"],
			deny: []
		},
		browserAllowHostControl: false,
		...sandboxOverrides,
		docker
	};
}
//#endregion
//#region src/agents/skills.e2e-test-helpers.ts
async function writeSkill(params) {
	const { dir, name, description, metadata, body, frontmatterExtra } = params;
	await fs.mkdir(dir, { recursive: true });
	const frontmatter = [
		`name: ${name}`,
		`description: ${description}`,
		metadata ? `metadata: ${metadata}` : "",
		frontmatterExtra ?? ""
	].filter((line) => line.trim().length > 0).join("\n");
	await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---

${body ?? `# ${name}\n`}
`, "utf-8");
}
//#endregion
//#region src/agents/test-helpers/usage-fixtures.ts
const ZERO_USAGE_FIXTURE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0
	}
};
//#endregion
//#region src/agents/test-helpers/agent-message-fixtures.ts
function castAgentMessage(message) {
	return message;
}
function makeAgentUserMessage(overrides) {
	return {
		role: "user",
		timestamp: 0,
		...overrides
	};
}
function makeAgentAssistantMessage(overrides) {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: ZERO_USAGE_FIXTURE,
		stopReason: "stop",
		timestamp: 0,
		...overrides
	};
}
//#endregion
//#region src/test-utils/chunk-test-helpers.ts
function countLines(text) {
	return text.split("\n").length;
}
function hasBalancedFences(chunk) {
	let open = null;
	for (const line of chunk.split("\n")) {
		const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
		if (!match) continue;
		const marker = match[2];
		if (!open) {
			open = {
				markerChar: marker[0],
				markerLen: marker.length
			};
			continue;
		}
		if (open.markerChar === marker[0] && marker.length >= open.markerLen) open = null;
	}
	return open === null;
}
//#endregion
//#region src/test-utils/auth-token-assertions.ts
function expectGeneratedTokenPersistedToGatewayAuth(params) {
	expect(params.generatedToken).toMatch(/^[0-9a-f]{48}$/);
	expect(params.authToken).toBe(params.generatedToken);
	expect(params.persistedConfig?.gateway?.auth?.mode).toBe("token");
	expect(params.persistedConfig?.gateway?.auth?.token).toBe(params.generatedToken);
}
//#endregion
//#region src/test-utils/typed-cases.ts
function typedCases(cases) {
	return cases;
}
//#endregion
export { castAgentMessage as a, writeSkill as c, firstWrittenJsonArg as d, spyRuntimeErrors as f, hasBalancedFences as i, createSandboxTestContext as l, spyRuntimeLogs as m, expectGeneratedTokenPersistedToGatewayAuth as n, makeAgentAssistantMessage as o, spyRuntimeJson as p, countLines as r, makeAgentUserMessage as s, typedCases as t, createCliRuntimeCapture as u };
