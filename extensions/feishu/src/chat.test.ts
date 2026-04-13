import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi, PluginRuntime } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const chatGetMock = vi.hoisted(() => vi.fn());
const chatMembersGetMock = vi.hoisted(() => vi.fn());
const contactUserGetMock = vi.hoisted(() => vi.fn());
const messageListMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
	createFeishuClient: createFeishuClientMock,
}));

let registerFeishuChatTools: typeof import("./chat.js").registerFeishuChatTools;

function createFeishuToolRuntime(): PluginRuntime {
	return {} as PluginRuntime;
}

describe("registerFeishuChatTools", () => {
	function createChatToolApi(params: {
		config: OpenClawPluginApi["config"];
		registerTool: OpenClawPluginApi["registerTool"];
	}): OpenClawPluginApi {
		return createTestPluginApi({
			id: "feishu-test",
			name: "Feishu Test",
			source: "local",
			config: params.config,
			runtime: createFeishuToolRuntime(),
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			registerTool: params.registerTool,
		});
	}

	beforeAll(async () => {
		({ registerFeishuChatTools } = await import("./chat.js"));
	});

	beforeEach(() => {
		vi.clearAllMocks();
		createFeishuClientMock.mockReturnValue({
			im: {
				chat: { get: chatGetMock },
				chatMembers: { get: chatMembersGetMock },
				message: { list: messageListMock },
			},
			contact: {
				user: { get: contactUserGetMock },
			},
		});
	});

	it("registers feishu_chat and handles info/members actions", async () => {
		const registerTool = vi.fn();
		registerFeishuChatTools(
			createChatToolApi({
				config: {
					channels: {
						feishu: {
							enabled: true,
							appId: "app_id",
							appSecret: "app_secret", // pragma: allowlist secret
							tools: { chat: true },
						},
					},
				},
				registerTool,
			}),
		);

		expect(registerTool).toHaveBeenCalledTimes(1);
		const tool = registerTool.mock.calls[0]?.[0];
		expect(tool?.name).toBe("feishu_chat");

		chatGetMock.mockResolvedValueOnce({
			code: 0,
			data: { name: "group name", user_count: 3 },
		});
		const infoResult = await tool.execute("tc_1", {
			action: "info",
			chat_id: "oc_1",
		});
		expect(infoResult.details).toEqual(
			expect.objectContaining({
				chat_id: "oc_1",
				name: "group name",
				user_count: 3,
			}),
		);

		chatMembersGetMock.mockResolvedValueOnce({
			code: 0,
			data: {
				has_more: false,
				page_token: "",
				items: [
					{ member_id: "ou_1", name: "member1", member_id_type: "open_id" },
				],
			},
		});
		const membersResult = await tool.execute("tc_2", {
			action: "members",
			chat_id: "oc_1",
		});
		expect(membersResult.details).toEqual(
			expect.objectContaining({
				chat_id: "oc_1",
				members: [
					expect.objectContaining({ member_id: "ou_1", name: "member1" }),
				],
			}),
		);

		contactUserGetMock.mockResolvedValueOnce({
			code: 0,
			data: {
				user: {
					open_id: "ou_1",
					name: "member1",
					email: "member1@example.com",
					department_ids: ["od_1"],
				},
			},
		});
		const memberInfoResult = await tool.execute("tc_3", {
			action: "member_info",
			member_id: "ou_1",
		});
		expect(memberInfoResult.details).toEqual(
			expect.objectContaining({
				member_id: "ou_1",
				open_id: "ou_1",
				name: "member1",
				email: "member1@example.com",
				department_ids: ["od_1"],
			}),
		);
	});

	it("handles history action and parses message content", async () => {
		const registerTool = vi.fn();
		registerFeishuChatTools(
			createChatToolApi({
				config: {
					channels: {
						feishu: {
							enabled: true,
							appId: "app_id",
							appSecret: "app_secret", // pragma: allowlist secret
							tools: { chat: true },
						},
					},
				},
				registerTool,
			}),
		);

		const tool = registerTool.mock.calls[0]?.[0];

		messageListMock.mockResolvedValueOnce({
			code: 0,
			data: {
				has_more: false,
				page_token: "",
				items: [
					{
						message_id: "om_1",
						msg_type: "text",
						create_time: "1700000000",
						sender: { id: "ou_1", id_type: "open_id", sender_type: "user" },
						body: { content: '{"text":"hello world"}' },
					},
					{
						message_id: "om_2",
						msg_type: "image",
						create_time: "1700000001",
						sender: { id: "ou_2", id_type: "open_id", sender_type: "user" },
						body: { content: '{"image_key":"img_xxx"}' },
					},
				],
			},
		});

		const result = await tool.execute("tc_history", {
			action: "history",
			chat_id: "oc_1",
			page_size: 20,
		});
		expect(result.details).toEqual(
			expect.objectContaining({
				chat_id: "oc_1",
				has_more: false,
				messages: [
					expect.objectContaining({
						message_id: "om_1",
						content: "hello world",
					}),
					expect.objectContaining({
						message_id: "om_2",
						content: "[image]",
					}),
				],
			}),
		);
		expect(messageListMock).toHaveBeenCalledWith(
			expect.objectContaining({
				params: expect.objectContaining({
					container_id_type: "chat",
					container_id: "oc_1",
					page_size: 20,
				}),
			}),
		);
	});

	it("handles history action with post message content", async () => {
		const registerTool = vi.fn();
		registerFeishuChatTools(
			createChatToolApi({
				config: {
					channels: {
						feishu: {
							enabled: true,
							appId: "app_id",
							appSecret: "app_secret", // pragma: allowlist secret
							tools: { chat: true },
						},
					},
				},
				registerTool,
			}),
		);

		const tool = registerTool.mock.calls[0]?.[0];
		const postContent = JSON.stringify({
			zh_cn: {
				title: "Post Title",
				content: [
					[
						{ tag: "text", text: "Hello " },
						{ tag: "text", text: "World" },
					],
				],
			},
		});

		messageListMock.mockResolvedValueOnce({
			code: 0,
			data: {
				has_more: false,
				items: [
					{
						message_id: "om_post",
						msg_type: "post",
						create_time: "1700000000",
						sender: { id: "ou_1", id_type: "open_id", sender_type: "user" },
						body: { content: postContent },
					},
				],
			},
		});

		const result = await tool.execute("tc_post", {
			action: "history",
			chat_id: "oc_1",
		});
		const messages = (
			result.details as { messages: Array<{ content: string }> }
		).messages;
		expect(messages[0].content).toBe("Post Title\nHello World");
	});

	it("skips registration when chat tool is disabled", () => {
		const registerTool = vi.fn();
		registerFeishuChatTools(
			createChatToolApi({
				config: {
					channels: {
						feishu: {
							enabled: true,
							appId: "app_id",
							appSecret: "app_secret", // pragma: allowlist secret
							tools: { chat: false },
						},
					},
				},
				registerTool,
			}),
		);
		expect(registerTool).not.toHaveBeenCalled();
	});
});
