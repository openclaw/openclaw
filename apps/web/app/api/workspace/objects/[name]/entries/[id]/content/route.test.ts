import { beforeEach, describe, expect, it, vi } from "vitest";

const DB_FILE = "/ws/workspace.duckdb";
const OBJECT_DIR = "/ws/marketing/influencer";
const WORKSPACE_ROOT = "/ws";
const OBJECT_NAME = "influencer";
const ENTRY_ID = "entry-1";
const OBJECT_ID = "obj1";

vi.mock("fs", () => ({
	existsSync: vi.fn(() => false),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(() => ""),
	writeFileSync: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
	duckdbExecOnFile: vi.fn(() => true),
	duckdbQueryOnFile: vi.fn(() => []),
	findDuckDBForObject: vi.fn(() => DB_FILE),
	findObjectDir: vi.fn(() => OBJECT_DIR),
	resolveWorkspaceRoot: vi.fn(() => WORKSPACE_ROOT),
}));

async function callGet() {
	const { GET } = await import("./route.js");
	return GET(new Request("http://localhost/api/workspace/objects/influencer/entries/entry-1/content"), {
		params: Promise.resolve({ name: OBJECT_NAME, id: ENTRY_ID }),
	});
}

async function callPut(content: string) {
	const { PUT } = await import("./route.js");
	return PUT(
		new Request("http://localhost/api/workspace/objects/influencer/entries/entry-1/content", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		}),
		{ params: Promise.resolve({ name: OBJECT_NAME, id: ENTRY_ID }) },
	);
}

describe("entry content route", () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.restoreAllMocks();

		const fs = await import("fs");
		const workspace = await import("@/lib/workspace");

		vi.mocked(fs.existsSync).mockImplementation(() => false);
		vi.mocked(fs.readFileSync).mockReturnValue("");
		vi.mocked(workspace.duckdbExecOnFile).mockReturnValue(true);
		vi.mocked(workspace.findDuckDBForObject).mockReturnValue(DB_FILE);
		vi.mocked(workspace.findObjectDir).mockReturnValue(OBJECT_DIR);
		vi.mocked(workspace.resolveWorkspaceRoot).mockReturnValue(WORKSPACE_ROOT);
		vi.mocked(workspace.duckdbQueryOnFile).mockImplementation((_dbFile, sql) => {
			if (sql.includes("SELECT id FROM objects WHERE name =")) {
				return [{ id: OBJECT_ID }] as never;
			}
			if (sql.includes("FROM entries") && sql.includes("COUNT(*) as cnt")) {
				return [{ cnt: 1 }] as never;
			}
			if (sql.includes("information_schema.columns")) {
				return [{ cnt: 1 }] as never;
			}
			return [] as never;
		});
	});

	it("prefers the documents-table file path over a legacy entry-id filename (keeps readable docs connected)", async () => {
		const fs = await import("fs");
		const workspace = await import("@/lib/workspace");

		vi.mocked(fs.existsSync).mockImplementation((path) => {
			return String(path) === `${OBJECT_DIR}/yt-mikemurphy-001.md`
				|| String(path) === `${OBJECT_DIR}/${ENTRY_ID}.md`;
		});
		vi.mocked(fs.readFileSync).mockReturnValue("# Draft outreach");
		vi.mocked(workspace.duckdbQueryOnFile).mockImplementation((_dbFile, sql) => {
			if (sql.includes("SELECT id FROM objects WHERE name =")) {
				return [{ id: OBJECT_ID }] as never;
			}
			if (sql.includes("information_schema.columns")) {
				return [{ cnt: 1 }] as never;
			}
			if (sql.includes("FROM documents") && sql.includes(`WHERE entry_id = '${ENTRY_ID}'`)) {
				return [{
					file_path: "marketing/influencer/yt-mikemurphy-001.md",
					title: "Mike Murphy",
				}] as never;
			}
			return [] as never;
		});

		const response = await callGet();
		expect(response.status).toBe(200);

		const json = await response.json();
		expect(json).toEqual({
			content: "# Draft outreach",
			exists: true,
			path: "marketing/influencer/yt-mikemurphy-001.md",
		});
		expect(fs.readFileSync).toHaveBeenCalledWith(
			`${OBJECT_DIR}/yt-mikemurphy-001.md`,
			"utf-8",
		);
	});

	it("falls back to legacy entry-id markdown when no documents mapping exists (preserves older entry pages)", async () => {
		const fs = await import("fs");
		const workspace = await import("@/lib/workspace");

		vi.mocked(fs.existsSync).mockImplementation(
			(path) => String(path) === `${OBJECT_DIR}/${ENTRY_ID}.md`,
		);
		vi.mocked(fs.readFileSync).mockReturnValue("# Legacy entry page");
		vi.mocked(workspace.duckdbQueryOnFile).mockImplementation((_dbFile, sql) => {
			if (sql.includes("SELECT id FROM objects WHERE name =")) {
				return [{ id: OBJECT_ID }] as never;
			}
			if (sql.includes("information_schema.columns")) {
				return [{ cnt: 0 }] as never;
			}
			if (sql.includes("SELECT f.name as field_name")) {
				return [{ field_name: "Creator Name", value: "Mike Murphy" }] as never;
			}
			return [] as never;
		});

		const response = await callGet();
		expect(response.status).toBe(200);

		const json = await response.json();
		expect(json).toEqual({
			content: "# Legacy entry page",
			exists: true,
			path: `marketing/influencer/${ENTRY_ID}.md`,
		});
	});

	it("does not create or register a document for blank first writes (prevents empty entry pages)", async () => {
		const fs = await import("fs");
		const workspace = await import("@/lib/workspace");

		vi.mocked(fs.existsSync).mockReturnValue(false);
		vi.mocked(workspace.duckdbQueryOnFile).mockImplementation((_dbFile, sql) => {
			if (sql.includes("SELECT id FROM objects WHERE name =")) {
				return [{ id: OBJECT_ID }] as never;
			}
			if (sql.includes("FROM entries") && sql.includes("COUNT(*) as cnt")) {
				return [{ cnt: 1 }] as never;
			}
			if (sql.includes("information_schema.columns")) {
				return [{ cnt: 1 }] as never;
			}
			if (sql.includes("SELECT f.name as field_name")) {
				return [
					{ field_name: "Creator Name", value: "Mike Murphy" },
					{ field_name: "YouTube URL", value: "https://www.youtube.com/@MikeMurphy" },
				] as never;
			}
			if (sql.includes("SELECT entry_id")) {
				return [] as never;
			}
			return [] as never;
		});

		const response = await callPut("   \n");
		expect(response.status).toBe(200);

		const json = await response.json();
		expect(json).toEqual({
			ok: true,
			created: false,
			path: "marketing/influencer/yt-mikemurphy-001.md",
		});
		expect(fs.writeFileSync).not.toHaveBeenCalled();
		expect(workspace.duckdbExecOnFile).not.toHaveBeenCalled();
	});

	it("skips existing unregistered readable filenames when generating a new path (prevents overwriting unrelated docs)", async () => {
		const fs = await import("fs");
		const workspace = await import("@/lib/workspace");

		vi.mocked(fs.existsSync).mockImplementation(
			(path) => String(path) === `${OBJECT_DIR}/yt-mikemurphy-001.md`,
		);
		vi.mocked(workspace.duckdbQueryOnFile).mockImplementation((_dbFile, sql) => {
			if (sql.includes("SELECT id FROM objects WHERE name =")) {
				return [{ id: OBJECT_ID }] as never;
			}
			if (sql.includes("FROM entries") && sql.includes("COUNT(*) as cnt")) {
				return [{ cnt: 1 }] as never;
			}
			if (sql.includes("information_schema.columns")) {
				return [{ cnt: 1 }] as never;
			}
			if (sql.includes("SELECT f.name as field_name")) {
				return [
					{ field_name: "Creator Name", value: "Mike Murphy" },
					{ field_name: "YouTube URL", value: "https://www.youtube.com/@MikeMurphy" },
				] as never;
			}
			if (sql.includes("SELECT entry_id")) {
				return [] as never;
			}
			return [] as never;
		});

		const response = await callPut("# Draft outreach");
		expect(response.status).toBe(200);

		const json = await response.json();
		expect(json).toEqual({
			ok: true,
			created: true,
			path: "marketing/influencer/yt-mikemurphy-002.md",
		});
		expect(fs.mkdirSync).toHaveBeenCalledWith(OBJECT_DIR, { recursive: true });
		expect(fs.writeFileSync).toHaveBeenCalledWith(
			`${OBJECT_DIR}/yt-mikemurphy-002.md`,
			"# Draft outreach",
			"utf-8",
		);

		const execSql = vi
			.mocked(workspace.duckdbExecOnFile)
			.mock.calls.map(([, sql]) => String(sql));
		expect(
			execSql.some((sql) =>
				sql.includes("ALTER TABLE documents ADD COLUMN IF NOT EXISTS entry_id VARCHAR"),
			),
		).toBe(true);
		expect(
			execSql.some((sql) =>
				sql.includes("INSERT INTO documents (title, file_path, parent_object_id, entry_id)")
				&& sql.includes("yt-mikemurphy-002.md"),
			),
		).toBe(true);
	});
});
