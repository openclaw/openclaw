import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, normalize } from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** MIME types for common file extensions. */
const MIME_MAP: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	mp4: "video/mp4",
	webm: "video/webm",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	pdf: "application/pdf",
};

export async function GET(req: Request) {
	const url = new URL(req.url);
	const filePath = url.searchParams.get("path");
	const raw = url.searchParams.get("raw") === "true";

	if (!filePath) {
		return Response.json(
			{ error: "Missing 'path' query parameter" },
			{ status: 400 },
		);
	}

	// Normalize and resolve to prevent traversal
	const resolved = resolve(normalize(filePath));

	if (!existsSync(resolved)) {
		return Response.json(
			{ error: "File not found" },
			{ status: 404 },
		);
	}

	try {
		const stat = statSync(resolved);
		if (!stat.isFile()) {
			return Response.json(
				{ error: "Path is not a file" },
				{ status: 400 },
			);
		}
	} catch {
		return Response.json(
			{ error: "Cannot stat file" },
			{ status: 500 },
		);
	}

	// Raw mode: return binary content with appropriate MIME type
	if (raw) {
		try {
			const buffer = readFileSync(resolved);
			const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
			const mime = MIME_MAP[ext] ?? "application/octet-stream";
			return new Response(buffer, {
				headers: {
					"Content-Type": mime,
					"Content-Length": String(buffer.length),
				},
			});
		} catch {
			return Response.json(
				{ error: "Cannot read file" },
				{ status: 500 },
			);
		}
	}

	// Text mode: return content and type metadata (same shape as /api/workspace/file)
	try {
		const content = readFileSync(resolved, "utf-8");
		const ext = resolved.split(".").pop()?.toLowerCase();

		let type: "markdown" | "yaml" | "text" = "text";
		if (ext === "md" || ext === "mdx") {type = "markdown";}
		else if (ext === "yaml" || ext === "yml") {type = "yaml";}

		return Response.json({ content, type });
	} catch {
		return Response.json(
			{ error: "Cannot read file" },
			{ status: 500 },
		);
	}
}
