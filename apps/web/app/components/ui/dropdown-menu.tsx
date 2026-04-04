"use client";

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ChevronRightIcon, CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function DropdownMenu({
	...props
}: React.ComponentProps<typeof MenuPrimitive.Root>) {
	return (
		<MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
	);
}

function DropdownMenuPortal({
	...props
}: React.ComponentProps<typeof MenuPrimitive.Portal>) {
	return (
		<MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
	);
}

function DropdownMenuTrigger({
	className,
	...props
}: React.ComponentProps<typeof MenuPrimitive.Trigger>) {
	return (
		<MenuPrimitive.Trigger
			data-slot="dropdown-menu-trigger"
			className={cn("cursor-pointer outline-none ring-0 border-none", className)}
			{...props}
		/>
	);
}

function DropdownMenuContent({
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	className,
	...props
}: React.ComponentProps<typeof MenuPrimitive.Popup> &
	Pick<
		React.ComponentProps<typeof MenuPrimitive.Positioner>,
		"align" | "alignOffset" | "side" | "sideOffset"
	>) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Positioner
				className="isolate z-[10000] outline-none"
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
			>
				<MenuPrimitive.Popup
					data-slot="dropdown-menu-content"
					className={cn(
						"bg-neutral-100/[0.67] dark:bg-neutral-900/[0.67] border border-white dark:border-white/10 backdrop-blur-md text-[var(--color-text)] z-50 max-h-[var(--available-height)] min-h-0 min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-3xl p-1 shadow-[0_0_25px_0_rgba(0,0,0,0.16)] outline-none",
						"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
						className,
					)}
					{...props}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

function DropdownMenuGroup({
	...props
}: React.ComponentProps<typeof MenuPrimitive.Group>) {
	return (
		<MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
	);
}

function DropdownMenuLabel({
	className,
	inset,
	...props
}: React.ComponentProps<typeof MenuPrimitive.GroupLabel> & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.GroupLabel
			data-slot="dropdown-menu-label"
			data-inset={inset}
			className={cn(
				"px-2 py-1.5 text-sm font-medium",
				inset && "pl-8",
				className,
			)}
			{...props}
		/>
	);
}

function DropdownMenuItem({
	className,
	inset,
	variant = "default",
	onSelect,
	onClick,
	...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & {
	inset?: boolean;
	variant?: "default" | "destructive";
	onSelect?: () => void;
}) {
	const handleClick = (e: React.MouseEvent<HTMLDivElement> & { preventBaseUIHandler: () => void }) => {
		onClick?.(e);
		onSelect?.();
	};
	return (
		<MenuPrimitive.Item
			data-slot="dropdown-menu-item"
			data-inset={inset}
			data-variant={variant}
			className={cn(
				"bg-transparent hover:bg-neutral-400/15 text-sm transition-all relative flex cursor-pointer items-center gap-2 rounded-full px-2 py-1.5 outline-none ring-0 border-none select-none",
				"data-[variant=destructive]:text-[var(--color-error)] data-[variant=destructive]:hover:bg-[var(--color-error)]/10 data-[variant=destructive]:hover:text-[var(--color-error)]",
				inset && "pl-8",
				"[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			onClick={handleClick}
			{...props}
		/>
	);
}

function DropdownMenuSub({
	...props
}: React.ComponentProps<typeof MenuPrimitive.SubmenuRoot>) {
	return (
		<MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
	);
}

function DropdownMenuSubTrigger({
	className,
	inset,
	children,
	...props
}: React.ComponentProps<typeof MenuPrimitive.SubmenuTrigger> & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.SubmenuTrigger
			data-slot="dropdown-menu-sub-trigger"
			data-inset={inset}
			className={cn(
				"bg-transparent hover:bg-neutral-400/15 focus:bg-neutral-400/15 data-open:bg-neutral-400/15 flex cursor-pointer items-center gap-2 rounded-full px-2 py-1.5 text-sm outline-none select-none transition-all focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none",
				inset && "pl-8",
				"[&_svg:not([class*='text-'])]:text-[var(--color-text-muted)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			{children}
			<ChevronRightIcon className="ml-auto size-4" />
		</MenuPrimitive.SubmenuTrigger>
	);
}

function DropdownMenuSubContent({
	align = "start",
	alignOffset = -3,
	side = "right",
	sideOffset = 0,
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
	return (
		<DropdownMenuContent
			data-slot="dropdown-menu-sub-content"
			className={cn("min-w-[96px]", className)}
			align={align}
			alignOffset={alignOffset}
			side={side}
			sideOffset={sideOffset}
			{...props}
		/>
	);
}

function DropdownMenuCheckboxItem({
	className,
	children,
	checked,
	inset,
	...props
}: React.ComponentProps<typeof MenuPrimitive.CheckboxItem> & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.CheckboxItem
			data-slot="dropdown-menu-checkbox-item"
			data-inset={inset}
			className={cn(
				"hover:bg-neutral-400/15 focus:bg-neutral-400/15 relative flex cursor-pointer items-center gap-2 rounded-full py-1.5 pr-2 pl-8 text-sm outline-none select-none transition-colors",
				inset && "pl-8",
				"[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			checked={checked}
			{...props}
		>
			<span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
				<MenuPrimitive.CheckboxItemIndicator>
					<CheckIcon className="size-4" />
				</MenuPrimitive.CheckboxItemIndicator>
			</span>
			{children}
		</MenuPrimitive.CheckboxItem>
	);
}

function DropdownMenuRadioGroup({
	...props
}: React.ComponentProps<typeof MenuPrimitive.RadioGroup>) {
	return (
		<MenuPrimitive.RadioGroup
			data-slot="dropdown-menu-radio-group"
			{...props}
		/>
	);
}

function DropdownMenuRadioItem({
	className,
	children,
	inset,
	...props
}: React.ComponentProps<typeof MenuPrimitive.RadioItem> & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.RadioItem
			data-slot="dropdown-menu-radio-item"
			data-inset={inset}
			className={cn(
				"hover:bg-neutral-400/15 focus:bg-neutral-400/15 relative flex cursor-pointer items-center gap-2 rounded-full py-1.5 pr-2 pl-8 text-sm outline-none select-none transition-colors",
				inset && "pl-8",
				"[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				"data-disabled:pointer-events-none data-disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
				<MenuPrimitive.RadioItemIndicator>
					<CheckIcon className="size-4" />
				</MenuPrimitive.RadioItemIndicator>
			</span>
			{children}
		</MenuPrimitive.RadioItem>
	);
}

function DropdownMenuSeparator({
	className,
	...props
}: React.ComponentProps<typeof MenuPrimitive.Separator>) {
	return (
		<MenuPrimitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn(
				"bg-neutral-400/15 -mx-1 my-1 h-px",
				className,
			)}
			{...props}
		/>
	);
}

function DropdownMenuShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="dropdown-menu-shortcut"
			className={cn(
				"text-[var(--color-text-muted)] ml-auto text-xs tracking-widest",
				className,
			)}
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuPortal,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuSubContent,
};
