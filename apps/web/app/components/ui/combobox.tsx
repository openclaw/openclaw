"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { cn } from "@/lib/utils";

const Combobox = ComboboxPrimitive.Root;

const ComboboxInput = React.forwardRef<
	HTMLInputElement,
	React.ComponentProps<typeof ComboboxPrimitive.Input>
>(({ className, ...props }, ref) => (
	<ComboboxPrimitive.Input
		ref={ref}
		data-slot="combobox-input"
		className={cn(
			"w-full rounded-xl py-2 text-sm outline-none transition-colors",
			className,
		)}
		{...props}
	/>
));
ComboboxInput.displayName = "ComboboxInput";

function ComboboxContent({
	className,
	side = "bottom",
	sideOffset = 8,
	align = "start",
	alignOffset = 0,
	anchor,
	...props
}: React.ComponentProps<typeof ComboboxPrimitive.Popup> &
	Pick<
		React.ComponentProps<typeof ComboboxPrimitive.Positioner>,
		"side" | "align" | "sideOffset" | "alignOffset" | "anchor"
	>) {
	return (
		<ComboboxPrimitive.Portal>
			<ComboboxPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				alignOffset={alignOffset}
				anchor={anchor}
				className="isolate z-[10000]"
			>
				<ComboboxPrimitive.Popup
					data-slot="combobox-content"
					className={cn(
						"bg-neutral-100/[0.67] dark:bg-neutral-900/[0.67] border border-white dark:border-white/10 backdrop-blur-md text-[var(--color-text)] max-h-[var(--available-height)] w-[calc(var(--anchor-width)+48px)] overflow-hidden rounded-3xl p-1 shadow-[0_0_25px_0_rgba(0,0,0,0.16)] outline-none",
						"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
						className,
					)}
					{...props}
				/>
			</ComboboxPrimitive.Positioner>
		</ComboboxPrimitive.Portal>
	);
}

function ComboboxList({
	className,
	...props
}: React.ComponentProps<typeof ComboboxPrimitive.List>) {
	return (
		<ComboboxPrimitive.List
			data-slot="combobox-list"
			className={cn(
				"max-h-[300px] overflow-y-auto overscroll-contain thin-scrollbar",
				className,
			)}
			{...props}
		/>
	);
}

function ComboboxItem({
	className,
	children,
	...props
}: React.ComponentProps<typeof ComboboxPrimitive.Item>) {
	return (
		<ComboboxPrimitive.Item
			data-slot="combobox-item"
			className={cn(
				"bg-transparent data-highlighted:bg-neutral-400/15 text-sm transition-all relative flex w-full cursor-pointer items-center gap-2.5 rounded-2xl px-3 py-2 outline-none select-none",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			{children}
		</ComboboxPrimitive.Item>
	);
}

function ComboboxEmpty({
	className,
	...props
}: React.ComponentProps<typeof ComboboxPrimitive.Empty>) {
	return (
		<ComboboxPrimitive.Empty
			data-slot="combobox-empty"
			className={cn(
				"w-full py-3 text-center text-sm",
				className,
			)}
			style={{ color: "var(--color-text-muted)" }}
			{...props}
		/>
	);
}

export {
	Combobox,
	ComboboxInput,
	ComboboxContent,
	ComboboxList,
	ComboboxItem,
	ComboboxEmpty,
};
