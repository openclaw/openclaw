// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatModelSelector } from "./chat-model-selector";
import type { ChatModelOption } from "@/lib/chat-models";

const models: ChatModelOption[] = [
	{
		stableId: "anthropic.claude-opus-4-6-v1",
		displayName: "Claude Opus 4.6",
		provider: "anthropic",
		reasoning: true,
	},
	{
		stableId: "gpt-5.4",
		displayName: "GPT-5.4",
		provider: "openai",
		reasoning: true,
	},
	{
		stableId: "minimax-m2",
		displayName: "MiniMax M2",
		provider: "minimax",
		reasoning: true,
	},
	{
		stableId: "deepseek-v3",
		displayName: "DeepSeek V3",
		provider: "deepseek",
		reasoning: true,
	},
	{
		stableId: "kimi-k2",
		displayName: "Kimi K2",
		provider: "kimi",
		reasoning: true,
	},
];

describe("ChatModelSelector", () => {
	it("renders a compact trigger without the removed copy", () => {
		render(
			<ChatModelSelector
				models={models}
				selectedModel="gpt-5.4"
				onSelect={vi.fn()}
			/>,
		);

		expect(screen.queryByText("This chat only")).not.toBeInTheDocument();
		expect(screen.queryByText(/reasoning/i)).not.toBeInTheDocument();
		expect(screen.getByText("GPT-5.4")).toBeInTheDocument();
	});

	it("uses the requested provider brand assets", () => {
		const { rerender } = render(
			<ChatModelSelector
				models={models}
				selectedModel="gpt-5.4"
				onSelect={vi.fn()}
			/>,
		);

		expect(document.querySelector('[data-provider-icon="openai"]')).not.toBeNull();

		rerender(
			<ChatModelSelector
				models={models}
				selectedModel="anthropic.claude-opus-4-6-v1"
				onSelect={vi.fn()}
			/>,
		);
		expect(document.querySelector('[data-provider-icon="claude"]')).not.toBeNull();

		rerender(
			<ChatModelSelector
				models={models}
				selectedModel="minimax-m2"
				onSelect={vi.fn()}
			/>,
		);
		expect(document.querySelector('img[src="/models/minimax.png"]')).not.toBeNull();

		rerender(
			<ChatModelSelector
				models={models}
				selectedModel="deepseek-v3"
				onSelect={vi.fn()}
			/>,
		);
		expect(document.querySelector('img[src="/models/deepseek.ico"]')).not.toBeNull();

		rerender(
			<ChatModelSelector
				models={models}
				selectedModel="kimi-k2"
				onSelect={vi.fn()}
			/>,
		);
		expect(document.querySelector('img[src="/models/kimi.png"]')).not.toBeNull();
	});

	it("can render a placeholder for settings-style usage without falling back to the first model", () => {
		render(
			<ChatModelSelector
				models={[
					{ ...models[0], isRecommended: true },
					models[1],
				]}
				selectedModel={null}
				onSelect={vi.fn()}
				fallbackToFirst={false}
				placeholder="Choose a model..."
				ariaLabel="Select primary model"
			/>,
		);

		expect(screen.getByText("Choose a model...")).toBeInTheDocument();
		expect(screen.queryByText("Claude Opus 4.6")).not.toBeInTheDocument();
	});
});
