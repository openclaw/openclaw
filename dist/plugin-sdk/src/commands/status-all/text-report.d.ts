import type { RenderTableOptions, TableColumn } from "../../terminal/table.js";
type HeadingFn = (text: string) => string;
type TableRenderer = (input: RenderTableOptions) => string;
export type StatusReportSection = {
    kind: "lines";
    title: string;
    body: string[];
    skipIfEmpty?: boolean;
} | {
    kind: "table";
    title: string;
    width: number;
    renderTable: TableRenderer;
    columns: readonly TableColumn[];
    rows: Array<Record<string, string>>;
    trailer?: string | null;
    skipIfEmpty?: boolean;
} | {
    kind: "raw";
    body: string[];
    skipIfEmpty?: boolean;
};
export declare function appendStatusSectionHeading(params: {
    lines: string[];
    heading: HeadingFn;
    title: string;
}): void;
export declare function appendStatusReportSections(params: {
    lines: string[];
    heading: HeadingFn;
    sections: StatusReportSection[];
}): void;
export {};
