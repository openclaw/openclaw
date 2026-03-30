import { afterEach, describe, expect, it } from "vitest";
import { ircPlugin } from "./channel.js";
import { clearIrcRuntime } from "./runtime.js";

describe("irc outbound chunking", () => {
	afterEach(() => {
		clearIrcRuntime();
	});

	it("chunks outbound text without requiring IRC runtime initialization", () => {
		const chunker = ircPlugin.outbound?.chunker;
		if (!chunker) {
			throw new Error("irc outbound.chunker unavailable");
		}

		expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
	});
});
