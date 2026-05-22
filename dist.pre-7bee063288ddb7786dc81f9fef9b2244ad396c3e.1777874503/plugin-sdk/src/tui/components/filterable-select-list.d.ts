import type { Component } from "@mariozechner/pi-tui";
import { type SelectItem, type SelectListTheme } from "@mariozechner/pi-tui";
export interface FilterableSelectItem extends SelectItem {
    /** Additional searchable fields beyond label */
    searchText?: string;
    /** Pre-computed lowercase search text (label + description + searchText) for filtering */
    searchTextLower?: string;
}
export interface FilterableSelectListTheme extends SelectListTheme {
    filterLabel: (text: string) => string;
}
/**
 * Combines text input filtering with a select list.
 * User types to filter, arrows/j/k to navigate, Enter to select, Escape to clear/cancel.
 */
export declare class FilterableSelectList implements Component {
    private input;
    private selectList;
    private allItems;
    private maxVisible;
    private theme;
    private filterText;
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
    constructor(items: FilterableSelectItem[], maxVisible: number, theme: FilterableSelectListTheme);
    private applyFilter;
    invalidate(): void;
    render(width: number): string[];
    handleInput(keyData: string): void;
    getSelectedItem(): SelectItem | null;
    getFilterText(): string;
}
