import { vi } from "vitest";
type UsageFetchInput = string | Request | URL;
type UsageFetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;
type UsageFetchMock = ReturnType<typeof vi.fn<(input: UsageFetchInput, init?: RequestInit) => Promise<Response>>>;
export declare function makeResponse(status: number, body: unknown): Response;
export declare function toRequestUrl(input: UsageFetchInput): string;
export declare function createProviderUsageFetch(handler: UsageFetchHandler): typeof fetch & UsageFetchMock;
export {};
