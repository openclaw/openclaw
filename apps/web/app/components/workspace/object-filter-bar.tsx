"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
	type FilterGroup,
	type FilterRule,
	type SavedView,
	type FilterOperator,
	operatorsForFieldType,
	defaultOperatorForFieldType,
	isFilterGroup,
	filterId,
	describeRule,
	emptyFilterGroup,
} from "@/lib/object-filters";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Field = {
	id: string;
	name: string;
	type: string;
	enum_values?: string[];
	enum_colors?: string[];
	enum_multiple?: boolean;
	related_object_name?: string;
};

type ObjectFilterBarProps = {
	fields: Field[];
	filters: FilterGroup;
	onFiltersChange: (filters: FilterGroup) => void;
	savedViews: SavedView[];
	activeViewName?: string;
	onSaveView: (name: string) => void;
	onLoadView: (view: SavedView) => void;
	onDeleteView: (name: string) => void;
	onSetActiveView: (name: string | undefined) => void;
	/** Members for user-type fields. */
	members?: Array<{ id: string; name: string }>;
};

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function FilterIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
		</svg>
	);
}

function PlusIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 5v14" /><path d="M5 12h14" />
		</svg>
	);
}

function XIcon({ size = 12 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M18 6 6 18" /><path d="m6 6 12 12" />
		</svg>
	);
}

function ChevronDownIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="m6 9 6 6 6-6" />
		</svg>
	);
}

function BookmarkIcon() {
	return (
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
		</svg>
	);
}

function TrashIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
			<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
		</svg>
	);
}

// ---------------------------------------------------------------------------
// Field type icons for the picker
// ---------------------------------------------------------------------------

const FIELD_TYPE_ICONS: Record<string, string> = {
	text: "Aa",
	number: "#",
	date: "📅",
	boolean: "☑",
	enum: "🏷",
	relation: "🔗",
	user: "👤",
	richtext: "¶",
	email: "@",
};

// ---------------------------------------------------------------------------
// Dropdown (generic reusable portal-free popover)
// ---------------------------------------------------------------------------

function Dropdown({
	trigger,
	open,
	onOpenChange,
	children,
	align = "left",
}: {
	trigger: React.ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: React.ReactNode;
	align?: "left" | "right";
}) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {return;}
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onOpenChange(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open, onOpenChange]);

	return (
		<div ref={ref} className="relative inline-block">
			<div onClick={() => onOpenChange(!open)}>{trigger}</div>
			{open && (
				<div
					className="absolute z-50 mt-1 rounded-lg shadow-lg border py-1 min-w-[160px] sm:min-w-[200px] max-w-[calc(100vw-2rem)] max-h-[320px] overflow-y-auto"
					style={{
						background: "var(--color-surface)",
						borderColor: "var(--color-border)",
						[align === "right" ? "right" : "left"]: 0,
					}}
				>
					{children}
				</div>
			)}
		</div>
	);
}

function DropdownItem({
	children,
	onClick,
	danger,
	active,
}: {
	children: React.ReactNode;
	onClick: () => void;
	danger?: boolean;
	active?: boolean;
}) {
	return (
		<button
			type="button"
			className="w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer flex items-center gap-2"
			style={{
				color: danger ? "var(--color-error, #ef4444)" : active ? "var(--color-accent)" : "var(--color-text)",
				background: active ? "var(--color-accent-light, rgba(99,102,241,0.1))" : "transparent",
			}}
			onMouseEnter={(e) => {
				(e.currentTarget as HTMLElement).style.background = danger
					? "rgba(239,68,68,0.1)"
					: "var(--color-accent-light, rgba(99,102,241,0.1))";
			}}
			onMouseLeave={(e) => {
				(e.currentTarget as HTMLElement).style.background = active
					? "var(--color-accent-light, rgba(99,102,241,0.1))"
					: "transparent";
			}}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

// ---------------------------------------------------------------------------
// Value editors per field type
// ---------------------------------------------------------------------------

function TextValueEditor({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
}) {
	return (
		<input
			type="text"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder ?? "Value..."}
			className="px-2 py-1 rounded-md text-xs outline-none min-w-[80px] sm:min-w-[120px]"
			style={{
				background: "var(--color-bg)",
				border: "1px solid var(--color-border)",
				color: "var(--color-text)",
			}}
		/>
	);
}

function NumberValueEditor({
	value,
	valueTo,
	showRange,
	onChange,
}: {
	value: number | undefined;
	valueTo: number | undefined;
	showRange: boolean;
	onChange: (v: number | undefined, vTo?: number) => void;
}) {
	return (
		<div className="flex items-center gap-1">
			<input
				type="number"
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined, valueTo)}
				placeholder={showRange ? "Min" : "Value"}
				className="px-2 py-1 rounded-md text-xs outline-none w-20"
				style={{
					background: "var(--color-bg)",
					border: "1px solid var(--color-border)",
					color: "var(--color-text)",
				}}
			/>
			{showRange && (
				<>
					<span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>to</span>
					<input
						type="number"
						value={valueTo ?? ""}
						onChange={(e) => onChange(value, e.target.value ? Number(e.target.value) : undefined)}
						placeholder="Max"
						className="px-2 py-1 rounded-md text-xs outline-none w-20"
						style={{
							background: "var(--color-bg)",
							border: "1px solid var(--color-border)",
							color: "var(--color-text)",
						}}
					/>
				</>
			)}
		</div>
	);
}

function DateValueEditor({
	value,
	valueTo,
	showRange,
	showRelative,
	relativeAmount,
	relativeUnit,
	onChange,
}: {
	value: string;
	valueTo: string;
	showRange: boolean;
	showRelative: boolean;
	relativeAmount: number | undefined;
	relativeUnit: string | undefined;
	onChange: (updates: Partial<FilterRule>) => void;
}) {
	if (showRelative) {
		return (
			<div className="flex items-center gap-1">
				<input
					type="number"
					min={1}
					value={relativeAmount ?? 7}
					onChange={(e) => onChange({ relativeAmount: Number(e.target.value) || 7 })}
					className="px-2 py-1 rounded-md text-xs outline-none w-16"
					style={{
						background: "var(--color-bg)",
						border: "1px solid var(--color-border)",
						color: "var(--color-text)",
					}}
				/>
				<select
					value={relativeUnit ?? "days"}
					onChange={(e) => onChange({ relativeUnit: e.target.value as "days" | "weeks" | "months" })}
					className="px-2 py-1 rounded-md text-xs outline-none cursor-pointer"
					style={{
						background: "var(--color-bg)",
						border: "1px solid var(--color-border)",
						color: "var(--color-text)",
					}}
				>
					<option value="days">days</option>
					<option value="weeks">weeks</option>
					<option value="months">months</option>
				</select>
			</div>
		);
	}

	return (
		<div className="flex items-center gap-1">
			<input
				type="date"
				value={value}
				onChange={(e) => onChange({ value: e.target.value })}
				className="px-2 py-1 rounded-md text-xs outline-none"
				style={{
					background: "var(--color-bg)",
					border: "1px solid var(--color-border)",
					color: "var(--color-text)",
					colorScheme: "dark",
				}}
			/>
			{showRange && (
				<>
					<span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>to</span>
					<input
						type="date"
						value={valueTo}
						onChange={(e) => onChange({ valueTo: e.target.value })}
						className="px-2 py-1 rounded-md text-xs outline-none"
						style={{
							background: "var(--color-bg)",
							border: "1px solid var(--color-border)",
							color: "var(--color-text)",
							colorScheme: "dark",
						}}
					/>
				</>
			)}
		</div>
	);
}

function EnumValueEditor({
	value,
	enumValues,
	enumColors,
	multiple,
	onChange,
}: {
	value: string | string[];
	enumValues: string[];
	enumColors?: string[];
	multiple: boolean;
	onChange: (v: string | string[]) => void;
}) {
	const selected = Array.isArray(value) ? value : value ? [value] : [];

	if (multiple) {
		return (
			<div className="flex flex-wrap gap-1">
				{enumValues.map((opt, idx) => {
					const isSelected = selected.includes(opt);
					const color = enumColors?.[idx] ?? "#94a3b8";
					return (
						<button
							key={opt}
							type="button"
							onClick={() => {
								const next = isSelected
									? selected.filter((v) => v !== opt)
									: [...selected, opt];
								onChange(next.length === 1 && !Array.isArray(value) ? next[0] : next);
							}}
							className="px-2 py-0.5 rounded-full text-[10px] transition-colors cursor-pointer"
							style={{
								background: isSelected ? `${color}20` : "var(--color-surface)",
								border: `1px solid ${isSelected ? `${color}60` : "var(--color-border)"}`,
								color: isSelected ? color : "var(--color-text-muted)",
							}}
						>
							{opt}
						</button>
					);
				})}
			</div>
		);
	}

	return (
		<select
			value={typeof value === "string" ? value : value[0] ?? ""}
			onChange={(e) => onChange(e.target.value)}
			className="px-2 py-1 rounded-md text-xs outline-none cursor-pointer"
			style={{
				background: "var(--color-bg)",
				border: "1px solid var(--color-border)",
				color: "var(--color-text)",
				minWidth: 100,
			}}
		>
			<option value="">Select...</option>
			{enumValues.map((opt) => (
				<option key={opt} value={opt}>{opt}</option>
			))}
		</select>
	);
}

function BooleanValueEditor() {
	// Boolean ops (is_true / is_false) don't need a value input
	return null;
}

function RelationValueEditor({
	value,
	relatedObjectName,
	members,
	multiple,
	onChange,
}: {
	value: string | string[];
	relatedObjectName?: string;
	members?: Array<{ id: string; name: string }>;
	multiple: boolean;
	onChange: (v: string | string[]) => void;
}) {
	// For user fields, show member options; for relations, show a text input for IDs
	if (members && members.length > 0) {
		const selected = Array.isArray(value) ? value : value ? [value] : [];
		return (
			<div className="flex flex-wrap gap-1">
				{members.map((m) => {
					const isSelected = selected.includes(m.id);
					return (
						<button
							key={m.id}
							type="button"
							onClick={() => {
								if (multiple) {
									const next = isSelected
										? selected.filter((v) => v !== m.id)
										: [...selected, m.id];
									onChange(next);
								} else {
									onChange(isSelected ? "" : m.id);
								}
							}}
							className="px-2 py-0.5 rounded-full text-[10px] transition-colors cursor-pointer"
							style={{
								background: isSelected ? "var(--color-accent-light)" : "var(--color-surface)",
								border: `1px solid ${isSelected ? "var(--color-accent)" : "var(--color-border)"}`,
								color: isSelected ? "var(--color-accent)" : "var(--color-text-muted)",
							}}
						>
							{m.name}
						</button>
					);
				})}
			</div>
		);
	}

	// Fallback: text input for relation IDs
	return (
		<TextValueEditor
			value={Array.isArray(value) ? value.join(", ") : String(value ?? "")}
			onChange={(v) => {
				const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
				onChange(ids.length === 1 ? ids[0] : ids);
			}}
			placeholder={relatedObjectName ? `Search ${relatedObjectName}...` : "ID..."}
		/>
	);
}

// ---------------------------------------------------------------------------
// Filter rule row
// ---------------------------------------------------------------------------

function FilterRuleRow({
	rule,
	field,
	fields,
	members,
	onUpdate,
	onRemove,
}: {
	rule: FilterRule;
	field: Field | undefined;
	fields: Field[];
	members?: Array<{ id: string; name: string }>;
	onUpdate: (updates: Partial<FilterRule>) => void;
	onRemove: () => void;
}) {
	const fieldType = field?.type ?? "text";
	const operators = operatorsForFieldType(fieldType);

	const handleFieldChange = (fieldName: string) => {
		const newField = fields.find((f) => f.name === fieldName);
		const newType = newField?.type ?? "text";
		onUpdate({
			field: fieldName,
			operator: defaultOperatorForFieldType(newType),
			value: undefined,
			valueTo: undefined,
			relativeAmount: undefined,
			relativeUnit: undefined,
		});
	};

	const isRangeOp = rule.operator === "between" || rule.operator === "date_between";
	const isRelativeOp = rule.operator === "relative_past" || rule.operator === "relative_next";
	const isMultiOp = rule.operator === "is_any_of" || rule.operator === "is_none_of" || rule.operator === "has_any" || rule.operator === "has_none" || rule.operator === "has_all";
	const noValueNeeded = rule.operator === "is_empty" || rule.operator === "is_not_empty" || rule.operator === "is_true" || rule.operator === "is_false";

	return (
		<div className="flex items-center gap-1.5 flex-wrap">
			{/* Field selector */}
			<select
				value={rule.field}
				onChange={(e) => handleFieldChange(e.target.value)}
				className="px-2 py-1 rounded-md text-xs outline-none cursor-pointer font-medium"
				style={{
					background: "var(--color-bg)",
					border: "1px solid var(--color-border)",
					color: "var(--color-text)",
					maxWidth: 140,
				}}
			>
				{fields.map((f) => (
					<option key={f.name} value={f.name}>
						{FIELD_TYPE_ICONS[f.type] ?? "?"} {f.name}
					</option>
				))}
			</select>

			{/* Operator selector */}
			<select
				value={rule.operator}
				onChange={(e) => onUpdate({ operator: e.target.value as FilterOperator, value: undefined, valueTo: undefined })}
				className="px-2 py-1 rounded-md text-xs outline-none cursor-pointer"
				style={{
					background: "var(--color-bg)",
					border: "1px solid var(--color-border)",
					color: "var(--color-text-muted)",
				}}
			>
				{operators.map((op) => (
					<option key={op.value} value={op.value}>{op.label}</option>
				))}
			</select>

			{/* Value editor */}
			{!noValueNeeded && (
				<>
					{(fieldType === "text" || fieldType === "richtext" || fieldType === "email" || fieldType === "tags") && (
						<TextValueEditor
							value={String(rule.value ?? "")}
							onChange={(v) => onUpdate({ value: v })}
						/>
					)}

					{fieldType === "number" && (
						<NumberValueEditor
							value={typeof rule.value === "number" ? rule.value : undefined}
							valueTo={typeof rule.valueTo === "number" ? rule.valueTo : undefined}
							showRange={isRangeOp}
							onChange={(v, vTo) => onUpdate({ value: v, valueTo: vTo })}
						/>
					)}

					{fieldType === "date" && (
						<DateValueEditor
							value={String(rule.value ?? "")}
							valueTo={String(rule.valueTo ?? "")}
							showRange={isRangeOp}
							showRelative={isRelativeOp}
							relativeAmount={rule.relativeAmount}
							relativeUnit={rule.relativeUnit}
							onChange={onUpdate}
						/>
					)}

					{fieldType === "enum" && (
						<EnumValueEditor
							value={rule.value as string | string[] ?? ""}
							enumValues={field?.enum_values ?? []}
							enumColors={field?.enum_colors}
							multiple={isMultiOp}
							onChange={(v) => onUpdate({ value: v })}
						/>
					)}

					{fieldType === "boolean" && <BooleanValueEditor />}

					{(fieldType === "relation" || fieldType === "user") && (
						<RelationValueEditor
							value={rule.value as string | string[] ?? ""}
							relatedObjectName={field?.related_object_name}
							members={fieldType === "user" ? members : undefined}
							multiple={isMultiOp}
							onChange={(v) => onUpdate({ value: v })}
						/>
					)}
				</>
			)}

			{/* Remove button */}
			<button
				type="button"
				onClick={onRemove}
				className="p-1 rounded transition-colors cursor-pointer"
				style={{ color: "var(--color-text-muted)" }}
				title="Remove filter"
			>
				<XIcon size={14} />
			</button>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main ObjectFilterBar
// ---------------------------------------------------------------------------

export function ObjectFilterBar({
	fields,
	filters,
	onFiltersChange,
	savedViews,
	activeViewName,
	onSaveView,
	onLoadView,
	onDeleteView,
	onSetActiveView,
	members,
}: ObjectFilterBarProps) {
	const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
	const [viewsOpen, setViewsOpen] = useState(false);
	const [saveDialogOpen, setSaveDialogOpen] = useState(false);
	const [saveViewName, setSaveViewName] = useState("");
	const saveInputRef = useRef<HTMLInputElement>(null);

	const hasFilters = filters.rules.length > 0;

	// Focus save input when dialog opens
	useEffect(() => {
		if (saveDialogOpen && saveInputRef.current) {
			saveInputRef.current.focus();
		}
	}, [saveDialogOpen]);

	const addRule = useCallback(
		(fieldName: string) => {
			const field = fields.find((f) => f.name === fieldName);
			const fieldType = field?.type ?? "text";
			const newRule: FilterRule = {
				id: filterId(),
				field: fieldName,
				operator: defaultOperatorForFieldType(fieldType),
			};
			onFiltersChange({
				...filters,
				rules: [...filters.rules, newRule],
			});
			setFieldPickerOpen(false);
		},
		[fields, filters, onFiltersChange],
	);

	const updateRule = useCallback(
		(ruleId: string, updates: Partial<FilterRule>) => {
			const newRules = filters.rules.map((r) => {
				if (!isFilterGroup(r) && r.id === ruleId) {
					return { ...r, ...updates };
				}
				return r;
			});
			onFiltersChange({ ...filters, rules: newRules });
		},
		[filters, onFiltersChange],
	);

	const removeRule = useCallback(
		(ruleId: string) => {
			const newRules = filters.rules.filter((r) => {
				if (isFilterGroup(r)) {return true;}
				return r.id !== ruleId;
			});
			onFiltersChange({ ...filters, rules: newRules });
		},
		[filters, onFiltersChange],
	);

	const clearAll = useCallback(() => {
		onFiltersChange(emptyFilterGroup());
		onSetActiveView(undefined);
	}, [onFiltersChange, onSetActiveView]);

	const toggleConjunction = useCallback(() => {
		onFiltersChange({
			...filters,
			conjunction: filters.conjunction === "and" ? "or" : "and",
		});
	}, [filters, onFiltersChange]);

	const handleSaveView = useCallback(() => {
		if (!saveViewName.trim()) {return;}
		onSaveView(saveViewName.trim());
		setSaveViewName("");
		setSaveDialogOpen(false);
	}, [saveViewName, onSaveView]);

	// Group fields by type for the picker
	const groupedFields = useMemo(() => {
		const groups: Record<string, Field[]> = {};
		for (const f of fields) {
			const g = groups[f.type] ?? [];
			g.push(f);
			groups[f.type] = g;
		}
		return groups;
	}, [fields]);

	return (
		<div className="space-y-2">
			{/* Toolbar row */}
			<div
				className="flex items-center gap-2 flex-wrap"
			>
				{/* Filter icon + label */}
				<span
					className="flex items-center gap-1.5 text-xs font-medium"
					style={{ color: "var(--color-text-muted)" }}
				>
					<FilterIcon />
					Filters
				</span>

				{/* AND/OR toggle (only when 2+ rules) */}
				{filters.rules.length >= 2 && (
					<button
						type="button"
						onClick={toggleConjunction}
						className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider transition-colors cursor-pointer"
						style={{
							background: "var(--color-accent-light, rgba(99,102,241,0.1))",
							color: "var(--color-accent)",
							border: "1px solid var(--color-accent)",
						}}
						title={`Matching ${filters.conjunction === "and" ? "ALL" : "ANY"} rules. Click to toggle.`}
					>
						{filters.conjunction}
					</button>
				)}

				{/* Active filter chips */}
				{filters.rules.map((rule) => {
					if (isFilterGroup(rule)) {return null;}
					return (
						<span
							key={rule.id}
							className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] max-w-[180px] sm:max-w-[250px] truncate"
							style={{
								background: "var(--color-accent-light, rgba(99,102,241,0.1))",
								color: "var(--color-accent)",
								border: "1px solid var(--color-accent)",
							}}
							title={describeRule(rule)}
						>
							<span className="truncate">{describeRule(rule)}</span>
							<button
								type="button"
								onClick={() => removeRule(rule.id)}
								className="flex-shrink-0 cursor-pointer p-0.5 rounded-full transition-colors"
								style={{ color: "var(--color-accent)" }}
							>
								<XIcon size={10} />
							</button>
						</span>
					);
				})}

				{/* Add filter button */}
				<Dropdown
					trigger={
						<button
							type="button"
							className="flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors cursor-pointer"
							style={{
								color: "var(--color-text-muted)",
								border: "1px dashed var(--color-border)",
							}}
						>
							<PlusIcon /> Add filter
						</button>
					}
					open={fieldPickerOpen}
					onOpenChange={setFieldPickerOpen}
				>
					{Object.entries(groupedFields).map(([type, typeFields]) => (
						<div key={type}>
							<div
								className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider"
								style={{ color: "var(--color-text-muted)" }}
							>
								{FIELD_TYPE_ICONS[type] ?? "?"} {type}
							</div>
							{typeFields.map((f) => (
								<DropdownItem key={f.name} onClick={() => addRule(f.name)}>
									{f.name}
								</DropdownItem>
							))}
						</div>
					))}
				</Dropdown>

				{/* Clear all */}
				{hasFilters && (
					<button
						type="button"
						onClick={clearAll}
						className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] transition-colors cursor-pointer"
						style={{
							color: "var(--color-accent)",
							background: "var(--color-accent-light, rgba(99,102,241,0.1))",
						}}
					>
						<XIcon size={10} />
						Clear all
					</button>
				)}

				{/* Spacer */}
				<div className="flex-1" />

				{/* Saved views */}
				<Dropdown
					trigger={
						<button
							type="button"
							className="flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors cursor-pointer"
							style={{
								color: activeViewName ? "var(--color-accent)" : "var(--color-text-muted)",
								border: `1px solid ${activeViewName ? "var(--color-accent)" : "var(--color-border)"}`,
								background: activeViewName ? "var(--color-accent-light, rgba(99,102,241,0.1))" : "transparent",
							}}
						>
							<BookmarkIcon />
							{activeViewName ?? "Views"}
							<ChevronDownIcon />
						</button>
					}
					open={viewsOpen}
					onOpenChange={setViewsOpen}
					align="right"
				>
					{savedViews.length === 0 && (
						<div className="px-3 py-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
							No saved views
						</div>
					)}
					{savedViews.map((view) => (
						<div key={view.name} className="flex items-center group">
							<DropdownItem
								onClick={() => {
									onLoadView(view);
									setViewsOpen(false);
								}}
								active={activeViewName === view.name}
							>
								<span className="flex-1 truncate">{view.name}</span>
								{view.view_type && view.view_type !== "table" && (
									<span
										className="text-[9px] px-1.5 py-0.5 rounded ml-1 capitalize"
										style={{
											background: "var(--color-surface-hover)",
											color: "var(--color-text-muted)",
										}}
									>
										{view.view_type}
									</span>
								)}
								{view.filters && view.filters.rules.length > 0 && (
									<span
										className="text-[10px] ml-1"
										style={{ color: "var(--color-text-muted)" }}
									>
										{view.filters.rules.length} filter{view.filters.rules.length !== 1 ? "s" : ""}
									</span>
								)}
							</DropdownItem>
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onDeleteView(view.name);
								}}
								className="px-2 py-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity cursor-pointer"
								style={{ color: "var(--color-text-muted)" }}
								title="Delete view"
							>
								<TrashIcon />
							</button>
						</div>
					))}
					<div className="border-t my-1" style={{ borderColor: "var(--color-border)" }} />

					{hasFilters && !saveDialogOpen && (
						<DropdownItem onClick={() => setSaveDialogOpen(true)}>
							<BookmarkIcon />
							Save current filters as view...
						</DropdownItem>
					)}

					{saveDialogOpen && (
						<div className="px-3 py-2 flex items-center gap-1">
							<input
								ref={saveInputRef}
								type="text"
								value={saveViewName}
								onChange={(e) => setSaveViewName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {handleSaveView();}
								if (e.key === "Escape") {setSaveDialogOpen(false);}
							}}
								placeholder="View name..."
								className="px-2 py-1 rounded-md text-xs outline-none flex-1"
								style={{
									background: "var(--color-bg)",
									border: "1px solid var(--color-border)",
									color: "var(--color-text)",
								}}
							/>
							<button
								type="button"
								onClick={handleSaveView}
								className="px-2 py-1 rounded-md text-xs transition-colors cursor-pointer"
								style={{
									background: "var(--color-accent)",
									color: "white",
								}}
							>
								Save
							</button>
						</div>
					)}

					{activeViewName && (
						<>
							<div className="border-t my-1" style={{ borderColor: "var(--color-border)" }} />
							<DropdownItem onClick={() => {
								clearAll();
								setViewsOpen(false);
							}}>
								<XIcon size={12} />
								Clear active view
							</DropdownItem>
						</>
					)}
				</Dropdown>
			</div>

			{/* Expanded filter rule editors (shown when rules exist) */}
			{hasFilters && (
				<div className="space-y-1.5 pl-5">
					{filters.rules.map((rule, idx) => {
						if (isFilterGroup(rule)) {return null;}
						const field = fields.find((f) => f.name === rule.field);
						return (
							<div key={rule.id} className="flex items-center gap-1.5">
								{idx > 0 && (
									<span
										className="text-[10px] font-semibold uppercase w-8 text-center flex-shrink-0"
										style={{ color: "var(--color-text-muted)" }}
									>
										{filters.conjunction}
									</span>
								)}
								{idx === 0 && (
									<span className="w-8 flex-shrink-0" />
								)}
								<FilterRuleRow
									rule={rule}
									field={field}
									fields={fields}
									members={members}
									onUpdate={(updates) => updateRule(rule.id, updates)}
									onRemove={() => removeRule(rule.id)}
								/>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
