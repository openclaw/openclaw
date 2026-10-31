import {
  normalizeUniqueTrimmedStringList,
  uniqueValues,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildPollResponseContent,
  isPollStartType,
  parsePollStart,
  type PollStartContent,
} from "../poll-types.js";
import { withResolvedRoomAction } from "./client.js";
import type { MatrixActionClientOpts } from "./types.js";

function normalizeOptionIndexes(indexes: number[]): number[] {
  const normalized = indexes
    .map((index) => Math.trunc(index))
    .filter((index) => Number.isFinite(index) && index > 0);
  return uniqueValues(normalized);
}

export async function voteMatrixPoll(
  roomId: string,
  pollId: string,
  opts: MatrixActionClientOpts & {
    optionId?: string;
    optionIds?: string[];
    optionIndex?: number;
    optionIndexes?: number[];
  } = {},
) {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    const pollEvent = await client.getEvent(resolvedRoom, pollId);
    const eventType = typeof pollEvent.type === "string" ? pollEvent.type : "";
    if (!isPollStartType(eventType)) {
      throw new Error(`Event ${pollId} is not a Matrix poll start event.`);
    }

    const optionIds = [...(opts.optionIds ?? []), ...(opts.optionId ? [opts.optionId] : [])];
    const optionIndexes = [
      ...(opts.optionIndexes ?? []),
      ...(opts.optionIndex !== undefined ? [opts.optionIndex] : []),
    ];
    const pollContent = pollEvent.content as PollStartContent;
    const parsed = parsePollStart(pollContent);
    if (!parsed) {
      throw new Error("Matrix poll vote requires a valid poll start event.");
    }

    const selectedById = normalizeUniqueTrimmedStringList(optionIds);
    const selectedByIndex = normalizeOptionIndexes(optionIndexes ?? []).map((index) => {
      const answer = parsed.answers[index - 1];
      if (!answer) {
        throw new Error(
          `Matrix poll option index ${index} is out of range for a poll with ${parsed.answers.length} options.`,
        );
      }
      return answer.id;
    });

    const answerIds = normalizeUniqueTrimmedStringList([...selectedById, ...selectedByIndex]);
    if (answerIds.length === 0) {
      throw new Error("Matrix poll vote requires at least one poll option id or index.");
    }
    if (answerIds.length > parsed.maxSelections) {
      throw new Error(
        `Matrix poll allows at most ${parsed.maxSelections} selection${parsed.maxSelections === 1 ? "" : "s"}.`,
      );
    }

    const answerMap = new Map(parsed.answers.map((answer) => [answer.id, answer.text] as const));
    const labels = answerIds.map((answerId) => {
      const label = answerMap.get(answerId);
      if (!label) {
        throw new Error(
          `Matrix poll option id "${answerId}" is not valid for poll ${parsed.question}.`,
        );
      }
      return label;
    });
    const maxSelections = parsed.maxSelections;

    const content = buildPollResponseContent(pollId, answerIds);
    const eventId = await client.sendEvent(resolvedRoom, "m.poll.response", content);
    return {
      eventId: eventId ?? null,
      roomId: resolvedRoom,
      pollId,
      answerIds,
      labels,
      maxSelections,
    };
  });
}
