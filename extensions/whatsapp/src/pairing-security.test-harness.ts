import { vi } from "vitest";

export type AsyncMock<
	TArgs extends unknown[] = unknown[],
	TResult = unknown,
> = {
	(...args: TArgs): Promise<TResult>;
	mockReset: () => AsyncMock<TArgs, TResult>;
	mockResolvedValue: (value: TResult) => AsyncMock<TArgs, TResult>;
	mockResolvedValueOnce: (value: TResult) => AsyncMock<TArgs, TResult>;
};

export const loadConfigMock = vi.fn();
export const readAllowFromStoreMock = vi.fn() as AsyncMock;
export const upsertPairingRequestMock = vi.fn() as AsyncMock;

export function resetPairingSecurityMocks(config: Record<string, unknown>) {
	loadConfigMock.mockReset().mockReturnValue(config);
	readAllowFromStoreMock.mockReset().mockResolvedValue([]);
	upsertPairingRequestMock
		.mockReset()
		.mockResolvedValue({ code: "PAIRCODE", created: true });
}

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
	return {
		...actual,
		loadConfig: (...args: unknown[]) => loadConfigMock(...args),
	};
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("openclaw/plugin-sdk/conversation-runtime")
		>();
	return {
		...actual,
		upsertChannelPairingRequest: (...args: unknown[]) =>
			upsertPairingRequestMock(...args),
	};
});

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("openclaw/plugin-sdk/security-runtime")
		>();
	return {
		...actual,
		readStoreAllowFromForDmPolicy: async (
			params: Parameters<typeof actual.readStoreAllowFromForDmPolicy>[0],
		) =>
			await actual.readStoreAllowFromForDmPolicy({
				...params,
				readStore: async (provider, accountId) =>
					(await readAllowFromStoreMock(provider, accountId)) as string[],
			}),
	};
});
