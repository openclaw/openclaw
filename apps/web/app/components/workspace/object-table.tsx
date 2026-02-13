"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { type ColumnDef, type CellContext } from "@tanstack/react-table";
import { DataTable, type RowAction } from "./data-table";
import { RelationSelect } from "./relation-select";

/* ─── Types ─── */

type Field = {
	id: string;
	name: string;
	type: string;
	enum_values?: string[];
	enum_colors?: string[];
	enum_multiple?: boolean;
	related_object_id?: string;
	relationship_type?: string;
	related_object_name?: string;
	sort_order?: number;
};

type ReverseRelation = {
	fieldName: string;
	sourceObjectName: string;
	sourceObjectId: string;
	displayField: string;
	entries: Record<string, Array<{ id: string; label: string }>>;
};

type ObjectTableProps = {
	objectName: string;
	fields: Field[];
	entries: Record<string, unknown>[];
	members?: Array<{ id: string; name: string }>;
	relationLabels?: Record<string, Record<string, string>>;
	reverseRelations?: ReverseRelation[];
	onNavigateToObject?: (objectName: string) => void;
	onEntryClick?: (entryId: string) => void;
	onRefresh?: () => void;
};

type EntryRow = Record<string, unknown> & { entry_id?: string };

/* ─── Helpers ─── */

function parseRelationValue(value: string | null | undefined): string[] {
	if (!value) {return [];}
	const trimmed = value.trim();
	if (!trimmed) {return [];}
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {return parsed.map(String).filter(Boolean);}
		} catch { /* not JSON */ }
	}
	return [trimmed];
}

/* ─── Cell Renderers (read-only display) ─── */

function EnumBadge({ value, enumValues, enumColors }: { value: string; enumValues?: string[]; enumColors?: string[] }) {
	const idx = enumValues?.indexOf(value) ?? -1;
	const color = idx >= 0 && enumColors ? enumColors[idx] : "#94a3b8";
	return (
		<span
			className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
			style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}
		>
			{value}
		</span>
	);
}

function BooleanCell({ value }: { value: unknown }) {
	const isTrue = value === true || value === "true" || value === "1" || value === "yes";
	return (
		<span style={{ color: isTrue ? "var(--color-success)" : "var(--color-text-muted)" }}>
			{isTrue ? "Yes" : "No"}
		</span>
	);
}

function UserCell({ value, members }: { value: unknown; members?: Array<{ id: string; name: string }> }) {
	const memberId = String(value);
	const member = members?.find((m) => m.id === memberId);
	return (
		<span className="flex items-center gap-1.5">
			<span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium flex-shrink-0" style={{ background: "var(--color-accent)", color: "white" }}>
				{(member?.name ?? memberId).charAt(0).toUpperCase()}
			</span>
			<span className="truncate">{member?.name ?? memberId}</span>
		</span>
	);
}

function RelationCell({
	value, field, relationLabels, onNavigate,
}: {
	value: unknown; field: Field;
	relationLabels?: Record<string, Record<string, string>>;
	onNavigate?: (objectName: string) => void;
}) {
	const fieldLabels = relationLabels?.[field.name];
	const ids = parseRelationValue(String(value));
	if (ids.length === 0) {return <span style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>--</span>;}
	return (
		<span className="flex items-center gap-1 flex-wrap">
			{ids.map((id) => (
				<span
					key={id}
					onClick={(e) => { if (field.related_object_name && onNavigate) { e.stopPropagation(); onNavigate(field.related_object_name); } }}
					className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${field.related_object_name && onNavigate ? "cursor-pointer" : ""}`}
					style={{ background: "var(--color-chip-document)", color: "var(--color-chip-document-text)", border: "1px solid var(--color-border)" }}
				>
					<span className="truncate max-w-[180px]">{fieldLabels?.[id] ?? id}</span>
				</span>
			))}
		</span>
	);
}

function ReverseRelationCell({ links, sourceObjectName, onNavigate }: {
	links: Array<{ id: string; label: string }>;
	sourceObjectName: string;
	onNavigate?: (objectName: string) => void;
}) {
	if (!links || links.length === 0) {return <span style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>--</span>;}
	const display = links.slice(0, 5);
	const overflow = links.length - display.length;
	return (
		<span className="flex items-center gap-1 flex-wrap">
			{display.map((link) => (
				<span
					key={link.id}
					onClick={(e) => { e.stopPropagation(); onNavigate?.(sourceObjectName); }}
					className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium cursor-pointer"
					style={{ background: "var(--color-chip-database)", color: "var(--color-chip-database-text)", border: "1px solid var(--color-border)" }}
				>
					<span className="truncate max-w-[180px]">{link.label}</span>
				</span>
			))}
			{overflow > 0 && <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>+{overflow}</span>}
		</span>
	);
}

/* ─── Inline Edit Cell ─── */

function EditableCell({
	value: initialValue,
	entryId,
	fieldName,
	objectName,
	field,
	members,
	relationLabels,
	onNavigate,
	onSaved,
}: {
	value: unknown;
	entryId: string;
	fieldName: string;
	objectName: string;
	field: Field;
	members?: Array<{ id: string; name: string }>;
	relationLabels?: Record<string, Record<string, string>>;
	onNavigate?: (objectName: string) => void;
	onSaved?: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [localValue, setLocalValue] = useState(String(initialValue ?? ""));
	const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Sync with prop changes
	useEffect(() => {
		if (!editing) {setLocalValue(String(initialValue ?? ""));}
	}, [initialValue, editing]);

	// Focus input on edit start
	useEffect(() => {
		if (editing && inputRef.current) {inputRef.current.focus();}
	}, [editing]);

	// Non-editable types: render read-only (relations are now editable via dropdown)
	const isEditable = !["user"].includes(field.type);
	const isRelation = field.type === "relation" && !!field.related_object_name;

	const save = useCallback(async (val: string) => {
		try {
			await fetch(`/api/workspace/objects/${encodeURIComponent(objectName)}/entries/${encodeURIComponent(entryId)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ fields: { [fieldName]: val } }),
			});
			onSaved?.();
		} catch { /* ignore */ }
	}, [objectName, entryId, fieldName, onSaved]);

	const handleChange = (val: string) => {
		setLocalValue(val);
		if (saveTimerRef.current) {clearTimeout(saveTimerRef.current);}
		saveTimerRef.current = setTimeout(() => save(val), 500);
	};

	const handleBlur = () => {
		if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); save(localValue); }
		setEditing(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") { handleBlur(); }
		if (e.key === "Escape") { setEditing(false); setLocalValue(String(initialValue ?? "")); }
	};

	// Read-only display for non-editable types
	if (!isEditable) {
		if (field.type === "user") {return <UserCell value={initialValue} members={members} />;}
		return <span className="truncate block max-w-[300px]">{String(initialValue ?? "")}</span>;
	}

	// Editing mode — Excel-style seamless inline editing
	if (editing) {
		let editInput;
		if (isRelation) {
			return (
				<div
					className="-mx-3 -my-2 px-3 py-2"
					style={{
						background: "var(--color-bg)",
						boxShadow: "inset 0 0 0 2px var(--color-accent)",
					}}
				>
					<RelationSelect
						relatedObjectName={field.related_object_name!}
						value={String(initialValue ?? "")}
						multiple={field.relationship_type === "many_to_many"}
						onChange={(v) => { save(v); setEditing(false); }}
						variant="inline"
						autoFocus
					/>
				</div>
			);
		}
		if (field.type === "enum" && field.enum_values) {
			editInput = (
				<select
					ref={inputRef as React.RefObject<HTMLSelectElement>}
					value={localValue}
					onChange={(e) => { handleChange(e.target.value); setEditing(false); }}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					className="w-full text-xs outline-none bg-transparent"
					style={{ color: "var(--color-text)" }}
				>
					<option value="">--</option>
					{field.enum_values.map((v) => (
						<option key={v} value={v}>{v}</option>
					))}
				</select>
			);
		} else if (field.type === "boolean") {
			editInput = (
				<select
					ref={inputRef as React.RefObject<HTMLSelectElement>}
					value={localValue}
					onChange={(e) => { handleChange(e.target.value); setEditing(false); }}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					className="w-full text-xs outline-none bg-transparent"
					style={{ color: "var(--color-text)" }}
				>
					<option value="true">Yes</option>
					<option value="false">No</option>
				</select>
			);
		} else {
			editInput = (
				<input
					ref={inputRef as React.RefObject<HTMLInputElement>}
					type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
					value={localValue}
					onChange={(e) => handleChange(e.target.value)}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					className="w-full text-xs outline-none bg-transparent"
					style={{ color: "var(--color-text)" }}
				/>
			);
		}
		return (
			<div
				className="-mx-3 -my-2 px-3 py-2"
				style={{
					background: "var(--color-bg)",
					boxShadow: "inset 0 0 0 2px var(--color-accent)",
				}}
			>
				{editInput}
			</div>
		);
	}

	// Display mode — double-click to edit
	const displayValue = initialValue;

	// Relation fields: show chips with double-click to edit
	if (isRelation) {
		return (
			<div
				onDoubleClick={() => setEditing(true)}
				className="cursor-cell min-h-[1.5em]"
				title="Double-click to edit"
			>
				<RelationCell value={initialValue} field={field} relationLabels={relationLabels} onNavigate={onNavigate} />
			</div>
		);
	}

	return (
		<div
			onDoubleClick={() => setEditing(true)}
			className="cursor-cell min-h-[1.5em]"
			title="Double-click to edit"
		>
			{displayValue === null || displayValue === undefined || displayValue === "" ? (
				<span style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>--</span>
			) : field.type === "enum" ? (
				<EnumBadge value={String(displayValue)} enumValues={field.enum_values} enumColors={field.enum_colors} />
			) : field.type === "boolean" ? (
				<BooleanCell value={displayValue} />
			) : field.type === "email" ? (
				<a href={`mailto:${displayValue}`} className="underline underline-offset-2" style={{ color: "var(--color-accent)" }} onClick={(e) => e.stopPropagation()}>
					{String(displayValue)}
				</a>
			) : field.type === "number" ? (
				<span className="tabular-nums">{String(displayValue)}</span>
			) : (
				<span className="truncate block max-w-[300px]">{String(displayValue)}</span>
			)}
		</div>
	);
}

/* ─── Main ObjectTable ─── */

export function ObjectTable({
	objectName,
	fields,
	entries,
	members,
	relationLabels,
	reverseRelations,
	onNavigateToObject,
	onEntryClick,
	onRefresh,
}: ObjectTableProps) {
	const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
	const [showAddModal, setShowAddModal] = useState(false);

	const activeReverseRelations = useMemo(() => {
		if (!reverseRelations) {return [];}
		return reverseRelations.filter((rr) => Object.keys(rr.entries).length > 0);
	}, [reverseRelations]);

	// Build TanStack columns from fields
	const columns = useMemo<ColumnDef<EntryRow>[]>(() => {
		const cols: ColumnDef<EntryRow>[] = fields.map((field, fieldIdx) => ({
			id: field.id,
			accessorKey: field.name,
			header: () => (
				<span className="flex items-center gap-1" style={{ color: "var(--color-text-muted)" }}>
					{field.name}
					{field.type === "relation" && field.related_object_name && (
						<span className="text-[9px] font-normal normal-case tracking-normal opacity-60">
							({field.related_object_name})
						</span>
					)}
				</span>
			),
			cell: (info: CellContext<EntryRow, unknown>) => {
				const entryId = String(info.row.original.entry_id ?? "");

				// First column (sticky): bold link that opens the entry detail modal
				if (fieldIdx === 0 && onEntryClick) {
					const val = info.getValue();
					const displayVal = val === null || val === undefined || val === "" ? "--" : String(val);
					const isEmpty = displayVal === "--";
					return (
						<span
							className={`font-semibold truncate block max-w-[300px] ${isEmpty ? "" : "cursor-pointer hover:underline"}`}
							style={{ color: isEmpty ? "var(--color-text-muted)" : "var(--color-accent)", opacity: isEmpty ? 0.5 : 1 }}
							onClick={(e) => {
								e.stopPropagation();
								if (entryId && !isEmpty) {onEntryClick(entryId);}
							}}
						>
							{displayVal}
						</span>
					);
				}

				return (
					<EditableCell
						value={info.getValue()}
						entryId={entryId}
						fieldName={field.name}
						objectName={objectName}
						field={field}
						members={members}
						relationLabels={relationLabels}
						onNavigate={onNavigateToObject}
						onSaved={onRefresh}
					/>
				);
			},
			size: field.type === "richtext" ? 300 : field.type === "relation" ? 200 : 180,
			enableSorting: true,
		}));

		// Add reverse relation columns
		for (const rr of activeReverseRelations) {
			cols.push({
				id: `rev_${rr.sourceObjectName}_${rr.fieldName}`,
				header: () => (
					<span className="flex items-center gap-1.5" style={{ color: "var(--color-text-muted)" }}>
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
							<path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
						</svg>
						<span className="capitalize">{rr.sourceObjectName}</span>
						<span className="text-[9px] font-normal normal-case tracking-normal opacity-50">via {rr.fieldName}</span>
					</span>
				),
				cell: (info: CellContext<EntryRow, unknown>) => {
					const entryId = String(info.row.original.entry_id ?? "");
					const links = rr.entries[entryId] ?? [];
					return <ReverseRelationCell links={links} sourceObjectName={rr.sourceObjectName} onNavigate={onNavigateToObject} />;
				},
				enableSorting: false,
				size: 200,
			});
		}

		return cols;
	}, [fields, activeReverseRelations, objectName, members, relationLabels, onNavigateToObject, onRefresh]);

	// Add entry handler — opens modal instead of creating empty entry
	const handleAdd = useCallback(() => {
		setShowAddModal(true);
	}, []);

	// Bulk delete handler
	const handleBulkDelete = useCallback(async () => {
		const selectedIds = Object.keys(rowSelection)
			.filter((k) => rowSelection[k])
			.map((idx) => String(entries[Number(idx)]?.entry_id ?? ""))
			.filter(Boolean);

		if (selectedIds.length === 0) {return;}
		if (!confirm(`Delete ${selectedIds.length} entries?`)) {return;}

		try {
			await fetch(`/api/workspace/objects/${encodeURIComponent(objectName)}/entries/bulk-delete`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ entryIds: selectedIds }),
			});
			setRowSelection({});
			onRefresh?.();
		} catch { /* ignore */ }
	}, [rowSelection, entries, objectName, onRefresh]);

	// Single delete handler
	const handleDeleteEntry = useCallback(async (entry: EntryRow) => {
		const entryId = String(entry.entry_id ?? "");
		if (!entryId) {return;}
		if (!confirm("Delete this entry?")) {return;}
		try {
			await fetch(`/api/workspace/objects/${encodeURIComponent(objectName)}/entries/${encodeURIComponent(entryId)}`, {
				method: "DELETE",
			});
			onRefresh?.();
		} catch { /* ignore */ }
	}, [objectName, onRefresh]);

	// Row actions
	const getRowActions = useCallback(
		(row: EntryRow): RowAction<EntryRow>[] => {
			const actions: RowAction<EntryRow>[] = [];
			if (onEntryClick) {
				actions.push({
					label: "View details",
					onClick: (r) => {
						const eid = String(r.entry_id ?? "");
						if (eid) {onEntryClick(eid);}
					},
					icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>,
				});
			}
			actions.push({
				label: "Delete",
				variant: "destructive",
				onClick: handleDeleteEntry,
				icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>,
			});
			return actions;
		},
		[onEntryClick, handleDeleteEntry],
	);

	// Column reorder handler
	const handleColumnReorder = useCallback(
		async (newOrder: string[]) => {
			// Map column IDs back to field IDs (exclude select, actions, and reverse relations)
			const fieldIds = newOrder.filter((id) => !id.startsWith("rev_") && id !== "select" && id !== "actions");
			try {
				await fetch(`/api/workspace/objects/${encodeURIComponent(objectName)}/fields/reorder`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ fieldOrder: fieldIds }),
				});
			} catch { /* ignore */ }
		},
		[objectName],
	);

	// Bulk actions toolbar
	const bulkActions = (
		<button
			type="button"
			onClick={handleBulkDelete}
			className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium"
			style={{ background: "rgba(220, 38, 38, 0.08)", color: "var(--color-error)", border: "1px solid rgba(220, 38, 38, 0.2)" }}
		>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
			Delete
		</button>
	);

	return (
	<>
		<DataTable
			columns={columns}
			data={entries as EntryRow[]}
			enableSorting
			enableGlobalFilter
			enableRowSelection
			enableColumnReordering
			rowSelection={rowSelection}
			onRowSelectionChange={setRowSelection}
			bulkActions={bulkActions}
			onColumnReorder={handleColumnReorder}
			searchPlaceholder={`Search ${objectName}...`}
			onRefresh={onRefresh}
			onAdd={handleAdd}
			addButtonLabel="+ Add"
			rowActions={getRowActions}
			stickyFirstColumn
		/>

			{/* Add Entry Modal */}
			{showAddModal && (
				<AddEntryModal
					objectName={objectName}
					fields={fields}
					members={members}
					onClose={() => setShowAddModal(false)}
					onSaved={onRefresh}
				/>
			)}
	</>
	);
}

/* ─── Add Entry Modal ─── */

function AddEntryModal({
	objectName,
	fields,
	members,
	onClose,
	onSaved,
}: {
	objectName: string;
	fields: Field[];
	members?: Array<{ id: string; name: string }>;
	onClose: () => void;
	onSaved?: () => void;
}) {
	const [values, setValues] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState(false);
	const backdropRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {onClose();}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	const updateField = (name: string, value: string) => {
		setValues((prev) => ({ ...prev, [name]: value }));
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			const res = await fetch(
				`/api/workspace/objects/${encodeURIComponent(objectName)}/entries`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ fields: values }),
				},
			);
			if (res.ok) {
				onSaved?.();
				onClose();
			}
		} catch { /* ignore */ }
		finally { setSaving(false); }
	};

	return (
		<div
			ref={backdropRef}
			onClick={(e) => { if (e.target === backdropRef.current) {onClose();} }}
			className="fixed inset-0 z-50 flex items-start justify-center"
			style={{ background: "rgba(0, 0, 0, 0.5)", backdropFilter: "blur(2px)" }}
		>
			<div
				className="relative mt-12 mb-12 w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl flex flex-col"
				style={{
					background: "var(--color-bg)",
					border: "1px solid var(--color-border)",
					maxHeight: "calc(100vh - 6rem)",
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0"
					style={{ borderColor: "var(--color-border)" }}
				>
					<h2 className="text-lg font-semibold capitalize" style={{ color: "var(--color-text)" }}>
						Add {objectName}
					</h2>
					<button type="button" onClick={onClose} className="p-1.5 rounded-lg" style={{ color: "var(--color-text-muted)" }}>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M18 6 6 18" /><path d="m6 6 12 12" />
						</svg>
					</button>
				</div>

				{/* Form */}
				<form
					onSubmit={(e) => { e.preventDefault(); handleSave(); }}
					className="flex-1 overflow-y-auto px-6 py-5 space-y-4"
				>
					{fields.map((field) => {
						const isRelation = field.type === "relation";
						const isUser = field.type === "user";

						return (
							<div key={field.id}>
								<label
									className="block text-xs font-medium uppercase tracking-wider mb-1.5"
									style={{ color: "var(--color-text-muted)" }}
								>
									{field.name}
									{isRelation && field.related_object_name && (
										<span className="normal-case tracking-normal font-normal opacity-60 ml-1">
											({field.related_object_name})
										</span>
									)}
								</label>

								{field.type === "enum" && field.enum_values ? (
									<select
										value={values[field.name] ?? ""}
										onChange={(e) => updateField(field.name, e.target.value)}
										className="w-full px-3 py-2 text-sm rounded-lg outline-none"
										style={{
											background: "var(--color-surface)",
											color: "var(--color-text)",
											border: "1px solid var(--color-border)",
										}}
									>
										<option value="">-- Select --</option>
										{field.enum_values.map((v) => (
											<option key={v} value={v}>{v}</option>
										))}
									</select>
								) : field.type === "boolean" ? (
									<select
										value={values[field.name] ?? ""}
										onChange={(e) => updateField(field.name, e.target.value)}
										className="w-full px-3 py-2 text-sm rounded-lg outline-none"
										style={{
											background: "var(--color-surface)",
											color: "var(--color-text)",
											border: "1px solid var(--color-border)",
										}}
									>
										<option value="">-- Select --</option>
										<option value="true">Yes</option>
										<option value="false">No</option>
									</select>
								) : field.type === "richtext" ? (
									<textarea
										value={values[field.name] ?? ""}
										onChange={(e) => updateField(field.name, e.target.value)}
										rows={3}
										className="w-full px-3 py-2 text-sm rounded-lg outline-none resize-none"
										style={{
											background: "var(--color-surface)",
											color: "var(--color-text)",
											border: "1px solid var(--color-border)",
										}}
										placeholder={field.name}
									/>
								) : isRelation && field.related_object_name ? (
									<RelationSelect
										relatedObjectName={field.related_object_name}
										value={values[field.name] ?? ""}
										multiple={field.relationship_type === "many_to_many"}
										onChange={(v) => updateField(field.name, v)}
										placeholder={`Select ${field.related_object_name}...`}
									/>
								) : isUser ? (
									<select
										value={values[field.name] ?? ""}
										onChange={(e) => updateField(field.name, e.target.value)}
										className="w-full px-3 py-2 text-sm rounded-lg outline-none"
										style={{
											background: "var(--color-surface)",
											color: "var(--color-text)",
											border: "1px solid var(--color-border)",
										}}
									>
										<option value="">-- Select member --</option>
										{members?.map((m) => (
											<option key={m.id} value={m.id}>{m.name}</option>
										))}
									</select>
								) : (
									<input
										type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : "text"}
										value={values[field.name] ?? ""}
										onChange={(e) => updateField(field.name, e.target.value)}
										className="w-full px-3 py-2 text-sm rounded-lg outline-none"
										style={{
											background: "var(--color-surface)",
											color: "var(--color-text)",
											border: "1px solid var(--color-border)",
										}}
										placeholder={field.name}
									/>
								)}
							</div>
						);
					})}
				</form>

				{/* Footer */}
				<div
					className="flex items-center justify-end gap-2 px-6 py-4 border-t flex-shrink-0"
					style={{ borderColor: "var(--color-border)" }}
				>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 text-sm rounded-lg"
						style={{ color: "var(--color-text-muted)", border: "1px solid var(--color-border)" }}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSave}
						disabled={saving}
						className="px-4 py-2 text-sm font-medium rounded-lg"
						style={{ background: "var(--color-accent)", color: "white", opacity: saving ? 0.7 : 1 }}
					>
						{saving ? "Saving..." : "Save"}
					</button>
				</div>
			</div>
		</div>
	);
}
