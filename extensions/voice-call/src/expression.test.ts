import { describe, expect, it } from "vitest";
import { inferEmotion } from "./expression.js";

describe("inferEmotion", () => {
  it("returns neutral for empty/whitespace/nullish text", () => {
    expect(inferEmotion("")).toBe("neutral");
    expect(inferEmotion("   ")).toBe("neutral");
    expect(inferEmotion(null)).toBe("neutral");
    expect(inferEmotion(undefined)).toBe("neutral");
  });

  it("detects happy from positive wording", () => {
    expect(inferEmotion("Great, that worked perfectly.")).toBe("happy");
    expect(inferEmotion("Thanks, glad I could help.")).toBe("happy");
    expect(inferEmotion("Congratulations on the launch.")).toBe("happy");
  });

  it("detects sad from apologetic/negative wording", () => {
    expect(inferEmotion("Sorry, I couldn't find that file.")).toBe("sad");
    expect(inferEmotion("Unfortunately the build failed.")).toBe("sad");
    expect(inferEmotion("I'm unable to reach the server.")).toBe("sad");
  });

  it("detects surprise from emphatic punctuation or words", () => {
    expect(inferEmotion("Wow, the tests all pass.")).toBe("surprised");
    expect(inferEmotion("That is incredible.")).toBe("surprised");
    expect(inferEmotion("It worked?!")).toBe("surprised");
    expect(inferEmotion("No way!!")).toBe("surprised");
  });

  it("falls back to neutral for plain statements", () => {
    expect(inferEmotion("The current time is 3 PM.")).toBe("neutral");
    expect(inferEmotion("Here is the file you asked for.")).toBe("neutral");
  });

  it("prioritises surprise over sad over happy", () => {
    // Surprise punctuation wins even with a polite "thanks".
    expect(inferEmotion("Thanks, but wow — really?!")).toBe("surprised");
    // Sad wording wins over an incidental "nice".
    expect(inferEmotion("Sorry, that wasn't nice of me.")).toBe("sad");
  });
});
