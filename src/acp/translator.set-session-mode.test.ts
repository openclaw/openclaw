import type { SetSessionModeRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import {
	createAcpConnection,
	createAcpGateway,
} from "./translator.test-helpers.js";

function createSetSessionModeRequest(modeId: string): SetSessionModeRequest {
	return {
		sessionId: "session-1",
		modeId,
	} as unknown as SetSessionModeRequest;
}

function createAgentWithSession(request: GatewayClient["request"]) {
	const sessionStore = createInMemorySessionStore();
	sessionStore.createSession({
		sessionId: "session-1",
		sessionKey: "agent:main:main",
		cwd: "/tmp",
	});
	return new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
		sessionStore,
	});
}

describe("acp setSessionMode", () => {
	it("setSessionMode propagates gateway error", async () => {
		const request = vi.fn(async () => {
			throw new Error("gateway rejected mode change");
		}) as GatewayClient["request"];
		const agent = createAgentWithSession(request);

		await expect(
			agent.setSessionMode(createSetSessionModeRequest("high")),
		).rejects.toThrow("gateway rejected mode change");
		expect(request).toHaveBeenCalledWith("sessions.patch", {
			key: "agent:main:main",
			thinkingLevel: "high",
		});
	});

	it("setSessionMode succeeds when gateway accepts", async () => {
		const request = vi.fn(async () => ({
			ok: true,
		})) as GatewayClient["request"];
		const agent = createAgentWithSession(request);

		await expect(
			agent.setSessionMode(createSetSessionModeRequest("low")),
		).resolves.toEqual({});
		expect(request).toHaveBeenCalledWith("sessions.patch", {
			key: "agent:main:main",
			thinkingLevel: "low",
		});
	});

	it("setSessionMode returns early for empty modeId", async () => {
		const request = vi.fn(async () => ({
			ok: true,
		})) as GatewayClient["request"];
		const agent = createAgentWithSession(request);

		await expect(
			agent.setSessionMode(createSetSessionModeRequest("")),
		).resolves.toEqual({});
		expect(request).not.toHaveBeenCalled();
	});
});
