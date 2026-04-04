"use client";

import { useMemo, useState } from "react";
import { PROMPT_SUGGESTIONS, type PromptSuggestion } from "@/lib/prompt-suggestions";

const VISIBLE_COUNT = 6;

function shuffleArray<T>(arr: T[]): T[] {
	const copy = [...arr];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

function pickRandom(count: number): PromptSuggestion[] {
	return shuffleArray(PROMPT_SUGGESTIONS).slice(0, count);
}

function SuggestionPill({
	suggestion,
	onClick,
}: {
	suggestion: PromptSuggestion;
	onClick: (prompt: string) => void;
}) {
	const Icon = suggestion.icon;
	const isBrand = suggestion.iconType === "brand";

	return (
		<button
			type="button"
			onClick={() => onClick(suggestion.prompt)}
			className="group flex items-center gap-1.5 px-3 md:px-3.5 py-1.5 md:py-2 text-[11px] md:text-xs font-medium whitespace-nowrap rounded-xl transition-all duration-200 border shrink-0"
			style={{
				background: "var(--color-surface)",
				borderColor: "var(--color-border)",
				color: "var(--color-text-secondary)",
			}}
		>
			<div
				className={`flex-shrink-0 transition-all duration-200 ${
					isBrand
						? "grayscale opacity-50 group-hover:grayscale-0 group-hover:opacity-100"
						: "opacity-45 group-hover:opacity-100"
				}`}
			>
				{isBrand ? (
					<Icon
						className="w-3.5 h-3.5"
						style={{ color: suggestion.brandColor }}
					/>
				) : (
					<Icon className="w-3.5 h-3.5" />
				)}
			</div>
			{suggestion.label}
		</button>
	);
}

export function HeroSuggestions({
	compact,
	onPromptClick,
}: {
	compact: boolean;
	onPromptClick: (prompt: string) => void;
}) {
	const [seed] = useState(0);

	const visible = useMemo(
		() => pickRandom(VISIBLE_COUNT),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[seed],
	);

	const row1 = visible.slice(0, 3);
	const row2 = visible.slice(3);

	return (
		<div
			className={`mt-4 md:mt-6 flex flex-col gap-2 md:gap-2.5 w-full max-w-[720px] mx-auto ${compact ? "px-2" : "px-4"}`}
		>
			<div className="flex items-center justify-center gap-2 flex-wrap">
				{row1.map((s) => (
					<SuggestionPill
						key={s.id}
						suggestion={s}
						onClick={onPromptClick}
					/>
				))}
			</div>
			<div className="flex items-center justify-center gap-2 flex-wrap">
				{row2.map((s) => (
					<SuggestionPill
						key={s.id}
						suggestion={s}
						onClick={onPromptClick}
					/>
				))}
			</div>
		</div>
	);
}
