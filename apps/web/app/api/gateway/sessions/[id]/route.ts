import { readFileSync } from "node:fs";
import { findSessionTranscriptFile, parseTranscriptToMessages } from "@/lib/gateway-transcript";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const transcriptFile = findSessionTranscriptFile(id);
  if (!transcriptFile) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const content = readFileSync(transcriptFile, "utf-8");
  const messages = parseTranscriptToMessages(content);

  return Response.json({ id, messages });
}
