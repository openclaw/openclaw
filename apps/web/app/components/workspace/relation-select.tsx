"use client";

import { useState, useEffect, useRef, useCallback } from "react";

type Option = { id: string; label: string };

type RelationSelectProps = {
	/** Name of the related object (e.g. "companies") */
	relatedObjectName: string;
	/** Current value — single ID string or JSON array of IDs */
	value: string;
	/** many_to_one = single select, many_to_many = multi-select */
	multiple?: boolean;
	/** Called when selection changes; value is a single ID or JSON array */
	onChange: (value: string) => void;
	/** Placeholder when nothing is selected */
	placeholder?: string;
	/** Visual variant: "modal" for form fields, "inline" for table cells */
	variant?: "modal" | "inline";
	/** Auto-focus the search input on mount */
	autoFocus?: boolean;
};

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

export function RelationSelect({
	relatedObjectName,
	value,
	multiple = false,
	onChange,
	placeholder,
	variant = "modal",
	autoFocus = false,
}: RelationSelectProps) {
	const [open, setOpen] = useState(autoFocus);
	const [search, setSearch] = useState("");
	const [options, setOptions] = useState<Option[]>([]);
	const [loading, setLoading] = useState(false);
	const [selectedIds, setSelectedIds] = useState<string[]>(() => parseRelationValue(value));
	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Sync external value changes
	useEffect(() => {
		setSelectedIds(parseRelationValue(value));
	}, [value]);

	// Fetch options when dropdown opens or search changes
	const fetchOptions = useCallback(async (query: string) => {
		setLoading(true);
		try {
			const params = new URLSearchParams();
			if (query) {params.set("q", query);}
			const res = await fetch(
				`/api/workspace/objects/${encodeURIComponent(relatedObjectName)}/entries/options?${params}`,
			);
			if (res.ok) {
				const data = await res.json();
				setOptions(data.options ?? []);
			}
		} catch { /* ignore */ }
		finally { setLoading(false); }
	}, [relatedObjectName]);

	useEffect(() => {
		if (open) {
			fetchOptions(search);
		}
	}, [open]); // eslint-disable-line react-hooks/exhaustive-deps

	// Debounced search
	useEffect(() => {
		if (!open) {return;}
		if (debounceRef.current) {clearTimeout(debounceRef.current);}
		debounceRef.current = setTimeout(() => fetchOptions(search), 250);
		return () => { if (debounceRef.current) {clearTimeout(debounceRef.current);} };
	}, [search]); // eslint-disable-line react-hooks/exhaustive-deps

	// Focus input when opening
	useEffect(() => {
		if (open && inputRef.current) {
			inputRef.current.focus();
		}
	}, [open]);

	// Close on outside click
	useEffect(() => {
		if (!open) {return;}
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const toggleSelect = (id: string) => {
		if (multiple) {
			const next = selectedIds.includes(id)
				? selectedIds.filter((x) => x !== id)
				: [...selectedIds, id];
			setSelectedIds(next);
			onChange(next.length === 0 ? "" : JSON.stringify(next));
		} else {
			setSelectedIds([id]);
			onChange(id);
			setOpen(false);
		}
	};

	const removeId = (id: string) => {
		const next = selectedIds.filter((x) => x !== id);
		setSelectedIds(next);
		if (multiple) {
			onChange(next.length === 0 ? "" : JSON.stringify(next));
		} else {
			onChange("");
		}
	};

	// Find labels for currently selected IDs (from loaded options, fallback to ID)
	const selectedLabels = selectedIds.map((id) => {
		const opt = options.find((o) => o.id === id);
		return { id, label: opt?.label ?? id };
	});

	const isInline = variant === "inline";

	return (
		<div ref={containerRef} className="relative w-full">
			{/* Trigger / display area */}
			<div
				onClick={() => setOpen(!open)}
				className={`w-full flex items-center flex-wrap gap-1 cursor-pointer min-h-[1.5em] ${isInline ? "text-xs" : "px-3 py-2 text-sm rounded-lg"}`}
				style={isInline ? {} : {
					background: "var(--color-surface)",
					color: "var(--color-text)",
					border: "1px solid var(--color-border)",
				}}
			>
				{selectedLabels.length > 0 ? (
					selectedLabels.map(({ id, label }) => (
						<span
							key={id}
							className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium"
							style={{
								background: "rgba(96, 165, 250, 0.1)",
								color: "#60a5fa",
								border: "1px solid rgba(96, 165, 250, 0.2)",
							}}
						>
							<span className="truncate max-w-[160px]">{label}</span>
							<button
								type="button"
								onClick={(e) => { e.stopPropagation(); removeId(id); }}
								className="ml-0.5 hover:opacity-70"
								style={{ color: "#60a5fa" }}
							>
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
									<path d="M18 6 6 18" /><path d="m6 6 12 12" />
								</svg>
							</button>
						</span>
					))
				) : (
					<span style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>
						{placeholder ?? `Select ${relatedObjectName}...`}
					</span>
				)}
				{/* Chevron */}
				<svg
					width="12" height="12" viewBox="0 0 24 24" fill="none"
					stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
					className="ml-auto flex-shrink-0"
					style={{ color: "var(--color-text-muted)", transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}
				>
					<path d="m6 9 6 6 6-6" />
				</svg>
			</div>

			{/* Dropdown */}
			{open && (
				<div
					className="absolute z-50 mt-1 w-full rounded-lg shadow-lg overflow-hidden"
					style={{
						background: "var(--color-bg)",
						border: "1px solid var(--color-border)",
						maxHeight: 260,
					}}
				>
					{/* Search input */}
					<div className="p-2 border-b" style={{ borderColor: "var(--color-border)" }}>
						<input
							ref={inputRef}
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder={`Search ${relatedObjectName}...`}
							className="w-full px-2.5 py-1.5 text-xs rounded-md outline-none"
							style={{
								background: "var(--color-surface)",
								color: "var(--color-text)",
								border: "1px solid var(--color-border)",
							}}
							onKeyDown={(e) => {
								if (e.key === "Escape") {setOpen(false);}
							}}
						/>
					</div>

					{/* Options list */}
					<div className="overflow-y-auto" style={{ maxHeight: 200 }}>
						{loading ? (
							<div className="px-3 py-4 text-center text-xs" style={{ color: "var(--color-text-muted)" }}>
								Loading...
							</div>
						) : options.length === 0 ? (
							<div className="px-3 py-4 text-center text-xs" style={{ color: "var(--color-text-muted)" }}>
								{search ? "No matches found" : "No entries"}
							</div>
						) : (
							options.map((opt) => {
								const isSelected = selectedIds.includes(opt.id);
								return (
									<button
										type="button"
										key={opt.id}
										onClick={() => toggleSelect(opt.id)}
										className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors"
										style={{
											background: isSelected ? "var(--color-accent-light, rgba(96, 165, 250, 0.08))" : "transparent",
											color: "var(--color-text)",
										}}
										onMouseEnter={(e) => { if (!isSelected) {(e.currentTarget.style.background = "var(--color-surface-hover, rgba(255,255,255,0.04))");}}}
										onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? "var(--color-accent-light, rgba(96, 165, 250, 0.08))" : "transparent"; }}
									>
										{/* Checkbox for multi-select */}
										{multiple && (
											<span
												className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0"
												style={{
													borderColor: isSelected ? "var(--color-accent)" : "var(--color-border)",
													background: isSelected ? "var(--color-accent)" : "transparent",
												}}
											>
												{isSelected && (
													<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
														<path d="M20 6 9 17l-5-5" />
													</svg>
												)}
											</span>
										)}
										{/* Single-select check indicator */}
										{!multiple && isSelected && (
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
												<path d="M20 6 9 17l-5-5" />
											</svg>
										)}
										<span className="truncate">{opt.label}</span>
									</button>
								);
							})
						)}
					</div>
				</div>
			)}
		</div>
	);
}
