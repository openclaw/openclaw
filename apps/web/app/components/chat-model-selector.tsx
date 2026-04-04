"use client";

import { ChevronDown, Loader2, Lock } from "lucide-react";
import {
	SiClaude,
	SiGoogle,
	SiMeta,
	SiMistralai,
	SiOpenai,
	SiPerplexity,
} from "react-icons/si";
import type { CSSProperties } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
	findChatModelByStableOrCatalogId,
	type ChatModelOption,
} from "@/lib/chat-models";

export type ChatModelSelectorOption = ChatModelOption & {
	isRecommended?: boolean;
};

function ProviderIcon({
	model,
	className,
}: {
	model: ChatModelOption;
	className?: string;
}) {
	const normalized = model.provider.trim().toLowerCase();
	const iconStyle: CSSProperties = { color: "currentColor" };

	if (normalized === "minimax" || normalized === "mini-max") {
		return (
			<img
				src="/models/minimax.png"
				alt=""
				className={className}
				draggable={false}
				data-provider-icon="minimax"
			/>
		);
	}

	if (normalized === "deepseek") {
		return (
			<img
				src="/models/deepseek.ico"
				alt=""
				className={className}
				draggable={false}
				data-provider-icon="deepseek"
			/>
		);
	}

	if (
		normalized === "kimi" ||
		normalized === "moonshot" ||
		normalized === "moonshotai"
	) {
		return (
			<img
				src="/models/kimi.png"
				alt=""
				className={className}
				draggable={false}
				data-provider-icon="kimi"
			/>
		);
	}

	switch (normalized) {
		case "anthropic":
		case "claude":
			return (
				<SiClaude
					className={className}
					style={iconStyle}
					data-provider-icon="claude"
				/>
			);
		case "openai":
		case "chatgpt":
			return (
				<SiOpenai
					className={className}
					style={iconStyle}
					data-provider-icon="openai"
				/>
			);
		case "google":
			return (
				<SiGoogle
					className={className}
					style={{ color: "#4285F4" }}
					data-provider-icon="google"
				/>
			);
		case "meta":
			return (
				<SiMeta
					className={className}
					style={{ color: "#0668E1" }}
					data-provider-icon="meta"
				/>
			);
		case "mistral":
			return (
				<SiMistralai
					className={className}
					style={{ color: "#FF7000" }}
					data-provider-icon="mistral"
				/>
			);
		case "perplexity":
			return (
				<SiPerplexity
					className={className}
					style={{ color: "#20B8CD" }}
					data-provider-icon="perplexity"
				/>
			);
		default:
			return (
				<span
					className={className}
					style={{
						color: "var(--color-text-muted)",
						fontSize: "0.75rem",
						fontWeight: 600,
						lineHeight: 1,
					}}
					aria-hidden
					data-provider-icon="fallback"
				>
					{model.provider.slice(0, 1).toUpperCase()}
				</span>
			);
	}
}

export function ChatModelSelector({
	models,
	selectedModel,
	onSelect,
	disabled = false,
	loading = false,
	disabledHint,
	fallbackToFirst = true,
	placeholder = "Choose a model...",
	ariaLabel = "Select chat model",
	triggerClassName,
}: {
	models: ChatModelSelectorOption[];
	selectedModel: string | null;
	onSelect: (stableId: string) => void;
	disabled?: boolean;
	/** When true with `disabled`, shows a spinner instead of the menu affordance. */
	loading?: boolean;
	/** Native tooltip when disabled (e.g. why the user can’t open the menu). */
	disabledHint?: string;
	fallbackToFirst?: boolean;
	placeholder?: string;
	ariaLabel?: string;
	triggerClassName?: string;
}) {
	const activeModel =
		findChatModelByStableOrCatalogId(models, selectedModel)
		?? (fallbackToFirst ? models[0] ?? null : null);

	if (models.length === 0) {
		return null;
	}

	const triggerTitle =
		disabled && loading
			? "Switching model…"
			: disabled && disabledHint?.trim()
				? disabledHint.trim()
				: (activeModel?.displayName ?? placeholder);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(
					"inline-flex max-w-full items-center gap-1.5 rounded-lg p-0 text-sm font-medium transition-opacity hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-60",
					triggerClassName,
				)}
				style={{ color: "var(--color-text-secondary)", opacity: 0.9 }}
				aria-label={ariaLabel}
				title={triggerTitle}
				disabled={disabled}
			>
				{activeModel ? (
					<ProviderIcon
						model={activeModel}
						className="h-3.5 w-3.5 shrink-0"
					/>
				) : (
					<span
						className="inline-block h-3.5 w-3.5 shrink-0 rounded-full"
						style={{ background: "var(--color-surface-hover)" }}
						aria-hidden
					/>
				)}
				<span
					className={cn("max-w-[240px] truncate", !activeModel && "italic")}
					style={!activeModel ? { color: "var(--color-text-muted)" } : undefined}
				>
					{activeModel?.displayName ?? placeholder}
				</span>
				{disabled && loading ? (
					<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
				) : disabled ? (
					<Lock className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
				) : (
					<ChevronDown className="h-3.5 w-3.5 shrink-0" />
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				side="bottom"
				sideOffset={8}
				className="min-w-[15rem] max-w-[20rem] p-1.5"
			>
				<DropdownMenuRadioGroup
					value={activeModel?.stableId ?? ""}
					onValueChange={(value) => {
						if (!disabled) {
							onSelect(value);
						}
					}}
				>
					{models.map((model) => (
						<DropdownMenuRadioItem key={model.stableId} value={model.stableId} disabled={disabled}>
							<ProviderIcon
								model={model}
								className="h-4 w-4 shrink-0"
							/>
							<div className="min-w-0 flex-1">
								<div
									className="truncate text-sm font-medium"
									style={{ color: "var(--color-text)" }}
								>
									{model.displayName}
								</div>
								<div
									className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px]"
									style={{ color: "var(--color-text-muted)" }}
								>
									<span>{model.provider}</span>
									{model.reasoning && <span>Reasoning</span>}
									{model.isRecommended && (
										<span
											className="rounded-full px-1.5 py-0.5"
											style={{
												background: "var(--color-surface-hover)",
												color: "var(--color-text)",
											}}
										>
											Recommended
										</span>
									)}
								</div>
							</div>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
