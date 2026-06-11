import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildChapterContextPacket,
  buildChapterRewritePrompt,
  buildCohesionArtifacts,
  buildCohesionAuditPrompt,
  buildHierarchicalMemory,
  buildParagraphContextPacket,
  buildParagraphRewritePrompt,
  classifyEditImpact,
  scoreCohesion,
} from "./cohesion.js";
import { resolveBookWriterConfig } from "./config.js";
import {
  approveBookPlanCover,
  archiveBookPlan,
  buildBookPlanQualityReport,
  buildFinalCohesionReport,
  buildGenreExcellenceReport,
  copyBookPlan,
  createAndSaveBookPlan,
  createQuickReadAndSave,
  deleteArchivedBookPlan,
  deleteBookPlan,
  deleteDeletedBookPlan,
  draftAndSaveBookPlan,
  draftAndSaveBookPlanParagraph,
  emptyDeletedBookPlans,
  fillAndSaveParagraphPlanFields,
  finishBookPlan,
  generateAndSaveChapterSetup,
  generateAndSaveIdeaSetup,
  isGenericChapterTitle,
  generateAndSaveBookPlanCoverConcept,
  listArchivedBookPlanProjects,
  listDeletedBookPlanProjects,
  listFinishedBookPlanProjects,
  listBookPlanProjects,
  listPenNameProfiles,
  propagateAndSaveStoryImpact,
  recommendNextBookFromPublishedBooks,
  readBookPlan,
  rebalanceAndSaveBookPlan,
  reorderChapter,
  reorderParagraph,
  restoreDeletedBookPlan,
  restoreArchivedBookPlan,
  restoreFinishedBookPlan,
  saveBookPlan,
  stitchAndSaveBookPlan,
  looksLikeInstructionalBookText,
  stripInstructionalBookText,
  suggestBookPlanFieldWithContext,
  suggestBookSetupTopicWithContext,
  updatePenNameProfile,
} from "./planning.js";

async function tempOutputDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-book-plan-test-"));
}

function bookTextFetch(text?: string): typeof fetch {
  return vi.fn(async () => {
    const content =
      text ??
      "On a damp Thursday evening, Mara stood in the records room and found the invoice, signature, ledger clue, and evidence file that kept the clean mystery moving toward its final reveal. The moment stayed precise, explicit, and alive: a local style accent carried more suspenseful pressure, dry humor, the main voice, polished and practical clarity, and language stays clean while she chose what she would do next.";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function capturingBookTextFetch(prompts: string[], text?: string): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const userMessage = Array.isArray(body.messages)
      ? body.messages.find((message: { role?: string }) => message.role === "user")
      : undefined;
    if (typeof userMessage?.content === "string") {
      prompts.push(userMessage.content);
    }
    const content =
      text ??
      "Mara crossed the rain-dark bridge with the invoice under her coat, aware that every bolt, ledger line, and quiet footstep had to connect to the same hidden signature. She did not reset the mystery; she carried the prior pressure forward and left the next clue waiting in the council file.";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function chapterBatchFetch(prompts: string[]): typeof fetch {
  let sequence = 0;
  const openings = [
    "Rain silvered the bridge railing while",
    "At the records counter,",
    "Under the council clock,",
    "Beside the inspection map,",
    "When the witness hesitated,",
    "After the ledger snapped shut,",
  ];
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const userMessage = Array.isArray(body.messages)
      ? body.messages.find((message: { role?: string }) => message.role === "user")
      : undefined;
    const prompt = typeof userMessage?.content === "string" ? userMessage.content : "";
    prompts.push(prompt);
    const ids: string[] = [];
    for (const match of prompt.matchAll(/- (para-[^:]+):/g)) {
      ids.push(match[1]);
    }
    const content = ids.length
      ? JSON.stringify({
          paragraphs: ids.map((id, index) => ({
            id,
            text: `${openings[sequence++ % openings.length]} Mara kept the bridge mystery moving through batch paragraph ${
              index + 1
            }, carrying the same invoice clue, the same council pressure, and the same clean suspense from the prior beat toward the next reveal. The rain on the railing, the file under her arm, and the careful silence in the records room all belonged to one continuous investigation. She noticed what had changed, chose her next step, and made the following paragraph necessary instead of letting the chapter reset. The paragraph reads as finished prose, not a plan, and it leaves the chapter more connected than it found it.`,
          })),
        })
      : "Mara carried the forged invoice clue from the prior beat into the next council-room consequence, keeping the same bridge danger, evidence file, and witness pressure visible. The revision tightened the transition around the locked ledger fact without changing it, preserved the clean mystery tone, and made the following choice feel earned.";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("book-writer planning studio model", () => {
  it("creates a versioned book-plan.json with editable chapters and paragraph plans", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original practical book about building a calm overnight automation business without paid cloud dependencies",
        targetWords: 9000,
        liveModel: false,
      },
    });

    expect(plan.schemaVersion).toBe(1);
    expect(plan.status).toBe("paragraph-plan");
    expect(plan.version).toBe(1);
    expect(plan.chapters.length).toBeGreaterThan(0);
    expect(plan.chapters[0].paragraphs.length).toBeGreaterThan(0);
    expect(plan.chapters[0].paragraphs[0].title).toBeTruthy();
    await expect(fs.stat(path.join(outputDir, plan.runId, "book-plan.json"))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, plan.runId, "book-bible.json")),
    ).resolves.toBeTruthy();
    await expect(fs.stat(path.join(outputDir, plan.runId, "outline.json"))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, plan.runId, "book-canon.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, plan.runId, "locked-constraints.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, plan.runId, "revision-map.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, plan.runId, "genre-excellence-report.json")),
    ).resolves.toBeTruthy();
    expect(plan.artifactLinks.bookCanon).toContain("book-canon.json");
    expect(plan.artifactLinks.revisionMap).toContain("revision-map.json");
    expect(plan.artifactLinks.genreExcellenceReport).toContain("genre-excellence-report.json");
    expect(plan.cohesionStatus).toBe("planned");
    expect(plan.qualityScore).toBeGreaterThan(0);
  });

  it("maintains hierarchical memory with book, character, timeline, chapter, scene, style, locked text, and storyline state", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original clean mystery about Mara Vale, who wants to expose a forged bridge invoice, but a hidden council culprit keeps moving the records. The stakes are the town's safety, and the story is moving toward a public reveal.",
        liveModel: false,
      },
    });
    const lockedText =
      "Mara keeps the council ledger sealed in a blue folder and refuses to let anyone alter that evidence.";
    const saved = await saveBookPlan({
      config,
      baseVersion: plan.version,
      action: "seed-locked-story-memory",
      summary: "Seed locked story memory.",
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? Object.assign({}, chapter, {
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 0
                    ? Object.assign({}, paragraph, {
                        text: lockedText,
                        locked: true,
                        status: "drafted" as const,
                      })
                    : paragraph,
                ),
              })
            : chapter,
        ),
      },
    });

    const memory = buildHierarchicalMemory(saved);
    const memoryArtifact = JSON.parse(
      await fs.readFile(path.join(outputDir, saved.runId, "hierarchical-memory.json"), "utf8"),
    ) as ReturnType<typeof buildHierarchicalMemory>;

    expect(memory.bookBible.mainStoryline).toContain("Mara Vale");
    expect(memory.bookBible.mainStoryline).toContain("wants");
    expect(memory.bookBible.mainStoryline).toContain("The stakes are");
    expect(memory.characterBible.map((character) => character.name).join(" ")).toContain("Mara");
    expect(memory.timeline.length).toBeGreaterThan(0);
    expect(memory.chapterMap[0].purpose).toBe(saved.chapters[0].description);
    expect(memory.sceneMap[0].paragraphIds).toContain(saved.chapters[0].paragraphs[0].id);
    expect(memory.styleGuide.proseRules.join(" ")).toContain("Every paragraph must serve");
    expect(memory.lockedTextMap[0].exactText).toBe(lockedText);
    expect(memoryArtifact.lockedTextMap[0].hash).toBe(memory.lockedTextMap[0].hash);
    expect(saved.artifactLinks.hierarchicalMemory).toContain("hierarchical-memory.json");
  });

  it("builds structured paragraph and chapter rewrite prompts from context packets instead of selected text alone", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original clean mystery about Mara Vale trying to expose a forged bridge invoice before the town vote.",
        liveModel: false,
      },
    });
    const chapter = plan.chapters[0];
    const paragraph = chapter.paragraphs[1];
    const packet = buildParagraphContextPacket({
      plan,
      chapter,
      paragraph,
      previous: chapter.paragraphs[0],
      next: chapter.paragraphs[2],
      userInstruction: "Make the clue feel inevitable without changing future consequences.",
    });
    const prompt = buildParagraphRewritePrompt(packet);
    const chapterPacket = buildChapterContextPacket({
      plan,
      chapter,
      chapterIndex: 0,
      userInstruction: "Rewrite the chapter while preserving the final reveal direction.",
    });
    const chapterPrompt = buildChapterRewritePrompt(chapterPacket);
    const auditPrompt = buildCohesionAuditPrompt({
      packet,
      candidateText:
        "Mara checked the invoice against the bridge bolts and carried the clue forward.",
    });

    expect(packet.previousParagraph).toBeTruthy();
    expect(packet.nextParagraph).toBeTruthy();
    expect(packet.mainStoryline).toContain("wants");
    expect(prompt).toContain("Expert role:");
    expect(prompt).toContain("Context packet:");
    expect(prompt).toContain("Brief plan before drafting:");
    expect(prompt).toContain("Cohesion rubric:");
    expect(prompt).toContain("Locked text rules");
    expect(chapterPrompt).toContain("Act structure");
    expect(chapterPrompt).toContain("Character arcs");
    expect(chapterPrompt).toContain("Setup/payoff needs");
    expect(auditPrompt).toContain("Return JSON only");
    expect(auditPrompt).toContain("lockedTextCompliance");
  });

  it("classifies edit impact and scores cohesion before save-time repair decisions", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original clean mystery about Mara Vale trying to expose a forged bridge invoice before the town vote.",
        liveModel: false,
      },
    });
    const chapter = plan.chapters[0];
    const paragraph = chapter.paragraphs[0];
    const packet = buildParagraphContextPacket({ plan, chapter, paragraph });
    const goodAudit = scoreCohesion({
      packet,
      candidateText:
        "Mara held the forged invoice beside the bridge report and saw how the same signature connected the opening clue to the town's larger danger. The choice kept the chapter moving from suspicion into consequence, carried the clean mystery promise forward, and left the next record search feeling necessary instead of detached.",
    });
    const badAudit = scoreCohesion({
      packet,
      candidateText: "This paragraph should explain the clue.",
    });

    expect(classifyEditImpact({ nextText: "Fix two words in the sentence." })).toBe("local");
    expect(classifyEditImpact({ nextText: "The scene emotion changes after Mara's choice." })).toBe(
      "scene",
    );
    expect(classifyEditImpact({ nextText: "Move the chapter transition and payoff." })).toBe(
      "chapter",
    );
    expect(
      classifyEditImpact({ nextText: "The culprit is actually Mara and the ending changes." }),
    ).toBe("book");
    expect(goodAudit.minimumScore).toBeGreaterThanOrEqual(8);
    expect(badAudit.status).toBe("flag");
    expect(badAudit.scores.clarity).toBeLessThan(6);
  });

  it("supports 250-word short story plans", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original 250-word flash mystery about a bridge invoice.",
        targetWords: 250,
        liveModel: false,
      },
    });

    expect(plan.targetWords).toBe(250);
    expect(plan.chapters).toHaveLength(1);
    expect(plan.chapters[0].targetWords).toBe(250);
    expect(plan.chapters[0].paragraphs).toHaveLength(1);
    expect(plan.chapters[0].paragraphs[0].targetWords).toBe(250);
  });

  it("makes short multi-chapter plans end with a resolution/payoff chapter", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original clean mystery novella about Mara Vale exposing a forged invoice before the town council vote.",
        targetWords: 1500,
        liveModel: false,
      },
    });
    const finalChapter = plan.chapters.at(-1);

    expect(plan.chapters).toHaveLength(3);
    expect(finalChapter?.role?.storyThread).toBe("resolution");
    expect(finalChapter?.role?.plotJob).toBe("payoff");
    expect(finalChapter?.description.toLowerCase()).toContain("payoff");
    expect(finalChapter?.description.toLowerCase()).toContain("closure");
    expect(finalChapter?.paragraphs.at(-1)?.title).toBe("Closure");
    expect(finalChapter?.paragraphs.at(-1)?.purpose.toLowerCase()).toContain("cliffhanger");
  });

  it("rebalances an existing long draft into model-assisted short story structure", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original clean mystery novella about Mara Vale and a forged invoice.",
        targetWords: 9000,
        liveModel: false,
      },
    });

    const rebalanced = await rebalanceAndSaveBookPlan({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
      targetWords: 250,
      fetchImpl: bookTextFetch(
        "Mara solved the forged invoice mystery in one precise, satisfying scene.",
      ),
    });

    expect(rebalanced.targetWords).toBe(250);
    expect(rebalanced.chapters).toHaveLength(1);
    expect(rebalanced.chapters[0].paragraphs).toHaveLength(1);
    expect(rebalanced.chapters[0].paragraphs[0]).toMatchObject({
      targetWords: 250,
      status: "drafted",
      text: "Mara solved the forged invoice mystery in one precise, satisfying scene.",
    });
    expect(rebalanced.bookSync).toMatchObject({
      state: "fully-updated",
      summary: expect.stringContaining("model-assisted"),
    });
  });

  it("infers fiction cast from the topic for downstream continuity gates", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original clean mystery novella about Mara Vale, a bridge inspector who discovers a forged invoice signature",
        targetWords: 9000,
        liveModel: false,
      },
    });

    const bible = JSON.parse(
      await fs.readFile(path.join(outputDir, plan.runId, "book-bible.json"), "utf8"),
    ) as { cast?: Array<{ name: string; role: string }> };
    expect(bible.cast).toContainEqual(
      expect.objectContaining({ name: "Mara Vale", role: "protagonist" }),
    );
  });

  it("marks major plot-twist paragraph edits as needing book propagation", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original clean mystery novella about Mara Vale, a bridge inspector investigating invoice fraud",
        targetWords: 9000,
        liveModel: false,
      },
    });

    const twistPlan = structuredClone(plan);
    twistPlan.chapters[2].paragraphs[1].text =
      "Mara realized the trusted council clerk was secretly her sister and the real mastermind behind the forged bridge invoice.";
    twistPlan.chapters[2].paragraphs[1].status = "drafted";
    const edited = await saveBookPlan({
      config,
      baseVersion: plan.version,
      action: "seed-plot-twist",
      summary: "Seed a major plot twist.",
      plan: twistPlan,
    });

    expect(edited.bookSync).toMatchObject({
      state: "needs-propagation",
      lockedConflictCount: 0,
    });
    expect(edited.bookSync?.affectedChapterIds.length).toBeGreaterThan(1);
    expect(edited.storyImpactEvents?.at(-1)).toMatchObject({
      impactLevel: "whole-book",
      twistTypes: expect.arrayContaining(["secret_relationship", "villain_reveal"]),
      status: "detected",
    });
    expect(edited.storylineOverview?.shortText).toContain("Current twist");
    await expect(
      fs.stat(path.join(outputDir, plan.runId, "story-impact-report.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, plan.runId, "storyline-overview.json")),
    ).resolves.toBeTruthy();
  });

  it("propagates pending plot twists through editable affected paragraphs", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original clean mystery novella about Mara Vale, a bridge inspector investigating invoice fraud",
        targetWords: 9000,
        liveModel: false,
      },
    });
    const twistPlan = structuredClone(plan);
    twistPlan.chapters[2].paragraphs[1].text =
      "Mara realized the trusted council clerk was secretly her sister and the real mastermind behind the forged bridge invoice.";
    twistPlan.chapters[2].paragraphs[1].status = "drafted";
    const edited = await saveBookPlan({
      config,
      baseVersion: plan.version,
      action: "seed-plot-twist",
      summary: "Seed a major plot twist.",
      plan: twistPlan,
    });

    const propagated = await propagateAndSaveStoryImpact({
      config,
      runId: edited.runId,
      baseVersion: edited.version,
    });

    expect(propagated.bookSync).toMatchObject({
      state: "fully-updated",
      pendingImpactId: undefined,
      lockedConflictCount: 0,
    });
    expect(propagated.storyImpactEvents?.at(-1)?.status).toBe("applied");
    const rewritten = propagated.bookSync?.affectedParagraphIds ?? [];
    expect(rewritten.length).toBeGreaterThan(0);
    expect(
      propagated.chapters
        .flatMap((chapter) => chapter.paragraphs)
        .filter((paragraph) => rewritten.includes(paragraph.id))
        .some((paragraph) =>
          paragraph.continuityObligations?.some((item) => item.includes("Story propagation")),
        ),
    ).toBe(true);
  });

  it("extracts locked text as immutable constraints for cohesion-aware drafting", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original clean mystery about Mara finding a bridge invoice clue before the final council meeting",
        liveModel: false,
      },
    });

    const lockedText =
      'Mara folded the bridge invoice into her coat and whispered, "The seventh signature is fake."';
    const locked = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 1
            ? {
                ...chapter,
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 0
                    ? { ...paragraph, text: lockedText, locked: true, status: "drafted" }
                    : paragraph,
                ),
              }
            : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "seed-lock",
      summary: "Seed locked text.",
    });

    const artifacts = buildCohesionArtifacts(locked);
    expect(artifacts.lockedConstraints.constraints).toHaveLength(1);
    expect(artifacts.lockedConstraints.constraints[0]).toMatchObject({
      location: "Chapter 2, paragraph 1",
      excerpt: lockedText,
      userDecisionNeeded: false,
    });
    expect(artifacts.canon.lockedConstraintIds).toEqual([
      artifacts.lockedConstraints.constraints[0].id,
    ]);
    expect(artifacts.sceneGraph.nodes.some((node) => node.lockConstraintIds.length === 1)).toBe(
      true,
    );
    const writtenConstraints = JSON.parse(
      await fs.readFile(path.join(outputDir, plan.runId, "locked-constraints.json"), "utf8"),
    ) as { constraints: Array<{ excerpt: string }> };
    expect(writtenConstraints.constraints[0].excerpt).toBe(lockedText);
  });

  it("rejects changes to locked Book Text until the paragraph is unlocked", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original practical book about lock-safe manuscript editing",
        liveModel: false,
      },
    });
    const lockedText = "This sentence is approved and must not be changed.";
    const locked = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? {
                ...chapter,
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 0
                    ? { ...paragraph, text: lockedText, locked: true, status: "drafted" }
                    : paragraph,
                ),
              }
            : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "lock",
      summary: "Lock approved prose.",
    });

    await expect(
      saveBookPlan({
        config,
        plan: {
          ...locked,
          chapters: locked.chapters.map((chapter, chapterIndex) =>
            chapterIndex === 0
              ? {
                  ...chapter,
                  paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                    paragraphIndex === 0 ? { ...paragraph, text: "Changed text." } : paragraph,
                  ),
                }
              : chapter,
          ),
        },
        baseVersion: locked.version,
        action: "illegal-lock-edit",
        summary: "Attempt to change locked prose.",
      }),
    ).rejects.toThrow("locked Book Text changed");
  });

  it("stores target length, tone, profanity, and page-control guidance in the plan", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original technical field guide about home battery backup planning",
        targetWords: 12000,
        tonePreset: "technical",
        profanityLevel: "extreme",
        liveModel: false,
      },
    });

    expect(plan.targetWords).toBe(12000);
    expect(plan.styleGuide).toMatchObject({
      tonePreset: "technical",
      profanityLevel: "extreme",
    });
    expect(plan.brief.tone).toContain("Technical");
    expect(plan.brief.constraints.join(" ")).toContain("Extreme profanity");
    expect(plan.chapters).toHaveLength(8);

    const drafted = await draftAndSaveBookPlan({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
      fetchImpl: bookTextFetch(),
    });
    const draftedText = drafted.chapters[0].paragraphs[0].text;
    expect(draftedText).toContain("precise");
    expect(draftedText).toContain("explicit");
    expect(looksLikeInstructionalBookText(draftedText)).toBe(false);

    const bible = JSON.parse(
      await fs.readFile(path.join(outputDir, plan.runId, "book-bible.json"), "utf8"),
    ) as { tone?: string; profanityLevel?: string; targetWords?: number };
    expect(bible).toMatchObject({
      targetWords: 12000,
      profanityLevel: "extreme",
    });
    expect(bible.tone).toContain("Technical");
  });

  it("flags and strips leaked story-planning scaffold prose", () => {
    const leaked =
      "The city was holding its breath.\n\nA small detail now points toward the later reveal without naming it outright.";
    expect(looksLikeInstructionalBookText(leaked)).toBe(true);
    expect(stripInstructionalBookText(leaked)).toBe("The city was holding its breath.");
  });

  it("fails plan quality when profanity is off and Book Text contains profanity", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original clean mystery about a quiet dock audit",
        profanityLevel: "none",
        liveModel: false,
      },
    });

    const seeded = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? {
                ...chapter,
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 0
                    ? {
                        ...paragraph,
                        text: "Audrey saw the damn ledger and knew the numbers did not belong.",
                        status: "drafted",
                      }
                    : paragraph,
                ),
              }
            : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "seed-profanity",
      summary: "Seed profanity for quality scan.",
    });

    expect(buildBookPlanQualityReport(seeded).findings).toContainEqual(
      expect.objectContaining({
        code: "profanity-control",
        status: "fail",
      }),
    );
  });

  it("stores and drafts with custom tone guidance", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original practical guide about calming family emergency routines",
        targetWords: 12000,
        tonePreset: "custom",
        tone: "Cozy, dryly funny, and emotionally warm.",
        profanityLevel: "none",
        liveModel: false,
      },
    });

    expect(plan.styleGuide).toMatchObject({
      tonePreset: "custom",
      toneDescription: "Cozy, dryly funny, and emotionally warm.",
      profanityLevel: "none",
    });
    expect(plan.brief.tone).toBe("Cozy, dryly funny, and emotionally warm.");

    const drafted = await draftAndSaveBookPlan({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
      fetchImpl: bookTextFetch(
        "On a calm evening, the family taped the emergency list beside the pantry while the custom tone: Cozy, dryly funny, and emotionally warm guided every small joke, every softened worry, and every practical choice they made together. By bedtime, the plan felt human enough to remember.",
      ),
    });

    expect(drafted.chapters[0].paragraphs[0].text).toContain(
      "custom tone: Cozy, dryly funny, and emotionally warm",
    );
  });

  it("uses chapter and paragraph style direction as local accents while preserving global tone", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original practical guide about calming family emergency routines",
        tonePreset: "professional",
        profanityLevel: "none",
        liveModel: false,
      },
    });
    const steered = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? {
                ...chapter,
                styleDirection: "Make this chapter more suspenseful but still warm.",
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 0
                    ? {
                        ...paragraph,
                        styleDirection: "Add dry humor here without changing the overall tone.",
                      }
                    : paragraph,
                ),
              }
            : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "style-direction",
      summary: "Add local style direction.",
    });

    const drafted = await draftAndSaveBookPlan({
      config,
      runId: steered.runId,
      baseVersion: steered.version,
      fetchImpl: bookTextFetch(),
    });
    const text = drafted.chapters[0].paragraphs[0].text;

    expect(text).toContain("local style accent");
    expect(text).toContain("more suspenseful");
    expect(text).toContain("dry humor");
    expect(text).toContain("main voice");
    expect(text).toContain("polished and practical");
    expect(text).toContain("language stays clean");
    expect(looksLikeInstructionalBookText(text)).toBe(false);
  });

  it("fills paragraph plans while preserving locked text boxes", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original clean mystery about a museum receipt that reveals a hidden theft",
        liveModel: false,
      },
    });
    const preservedSummary = "Locked: the receipt points at the wrong exhibit.";
    const edited = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? {
                ...chapter,
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 0
                    ? {
                        ...paragraph,
                        title: "",
                        summary: preservedSummary,
                        purpose: "",
                        styleDirection: "",
                        fieldLocks: { ...paragraph.fieldLocks, summary: true },
                      }
                    : paragraph,
                ),
              }
            : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "seed-locked-plan-field",
      summary: "Seed a locked paragraph plan field.",
    });

    const filled = await fillAndSaveParagraphPlanFields({
      config,
      runId: edited.runId,
      baseVersion: edited.version,
      chapterId: edited.chapters[0].id,
    });
    const paragraph = filled.chapters[0].paragraphs[0];

    expect(paragraph.summary).toBe(preservedSummary);
    expect(paragraph.title).toBe(`Paragraph ${filled.chapters[0].number}.${paragraph.order}`);
    expect(paragraph.purpose).toContain("receipt points");
    expect(paragraph.styleDirection).toContain("clear");
  });

  it("uses the idea-strategist to fill selected idea fields while keeping profanity off", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "A practical book about a quiet local AI publishing dashboard",
        profanityLevel: "extreme",
        liveModel: false,
      },
    });
    const fetchImpl = bookTextFetch(
      JSON.stringify({
        title: "The Quiet Publishing Machine",
        summary: "A practical operating manual for building a calm local AI book dashboard.",
        readerPromise: "Readers can plan and package cleaner books with less guesswork.",
        targetWords: 18000,
        tone: "Calm, expert, direct, and commercially useful.",
        audience: "Solo operators building a local-first publishing workflow.",
      }),
    );

    const filled = await generateAndSaveIdeaSetup({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
      targets: ["title", "summary", "readerPromise", "targetWords", "tone", "audience"],
      fetchImpl,
    });

    expect(filled.title).toBe("The Quiet Publishing Machine");
    expect(filled.brief.topicParagraph).toContain("local AI book dashboard");
    expect(filled.brief.readerPromise).toContain("less guesswork");
    expect(filled.targetWords).toBe(18000);
    expect(filled.brief.audience).toContain("Solo operators");
    expect(filled.styleGuide?.profanityLevel).toBe("none");
    expect(filled.brief.constraints.join(" ")).toContain("No profanity");
    expect(filled.revisionHistory.at(-1)?.action).toBe("idea-strategist");
  });

  it("creates specific non-generic chapter titles for new plans", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "Create a 250 word story about a Respiratory Therapist, named Respiratory, that saves the world with albuterol",
        targetWords: 250,
        liveModel: false,
      },
    });

    expect(plan.chapters).toHaveLength(1);
    expect(plan.chapters[0].title).not.toBe(plan.title);
    expect(isGenericChapterTitle(plan.chapters[0].title, plan.title)).toBe(false);
    expect(["The Promise", "The Stakes", "The Pattern"]).not.toContain(plan.chapters[0].title);
  });

  it("warns on generic chapter titles but fails only empty or duplicate titles", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original clean mystery about a locked bridge ledger",
        liveModel: false,
      },
    });
    const generic = {
      ...plan,
      chapters: plan.chapters.map((chapter) => ({ ...chapter, title: "The Problem" })),
    };
    expect(
      buildBookPlanQualityReport(generic).findings.find(
        (finding) => finding.code === "chapter-title-quality",
      )?.status,
    ).toBe("fail");
    const warned = structuredClone(plan);
    warned.chapters[0].title = "The Problem";
    warned.chapters[1].title = "The Stakes";
    warned.chapters[2].title = "The Pattern";
    expect(
      buildBookPlanQualityReport(warned).findings.find(
        (finding) => finding.code === "chapter-title-quality",
      )?.status,
    ).toBe("warn");
  });

  it("uses the chapter-architect to fill unlocked chapter fields with locked chapters as context", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original clean mystery about a locked bridge ledger",
        liveModel: false,
      },
    });
    const lockedTitle = "Locked Evidence";
    const seeded = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? {
                ...chapter,
                title: lockedTitle,
                description: "This locked chapter reveals the bridge ledger clue.",
                locked: true,
              }
            : chapterIndex === 1
              ? {
                  ...chapter,
                  fieldLocks: { ...chapter.fieldLocks, title: true, roleNotes: true },
                  role: { ...chapter.role!, notes: "Preserve this role note." },
                }
              : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "seed-locked-chapter",
      summary: "Seed locked chapter context.",
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(typeof init?.body === "string" ? init.body : "").toContain("Locked Evidence");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  chapters: seeded.chapters.map((chapter) => ({
                    id: chapter.id,
                    title: `The Ledger Under Door ${chapter.number}`,
                    description: `Chapter ${chapter.number} now flows from the locked ledger clue.`,
                    styleDirection: `Make chapter ${chapter.number} feel like a clue half-seen in fog.`,
                    role: {
                      storyThread: "main-story",
                      plotJob: "reveal",
                      readerFeeling: "suspenseful",
                      notes: `Architect role ${chapter.number}`,
                    },
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const filled = await generateAndSaveChapterSetup({
      config,
      runId: seeded.runId,
      baseVersion: seeded.version,
      targets: ["title", "description", "style", "role"],
      fetchImpl,
    });

    expect(filled.chapters[0].title).toBe(lockedTitle);
    expect(filled.chapters[0].description).toContain("locked chapter reveals");
    expect(filled.chapters[1].title).toBe(seeded.chapters[1].title);
    expect(filled.chapters[1].description).toContain("flows from the locked ledger");
    expect(filled.chapters[1].styleDirection).toContain("clue half-seen");
    expect(filled.chapters[1].role?.plotJob).toBe("reveal");
    expect(filled.chapters[1].role?.notes).toBe("Preserve this role note.");
    expect(filled.revisionHistory.at(-1)?.action).toBe("chapter-architect");
  });

  it("groups active and edited books by reusable pen name profile", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original practical guide about cozy low-cost home routines",
        penName: "M. J. Hearth",
        genre: "cozy practical home guides",
        liveModel: false,
      },
    });

    await updatePenNameProfile(config, {
      name: "M. J. Hearth",
      lane: "cozy practical home guides",
      readerPromise: "warm books that make household systems feel doable",
    });
    const profiles = await listPenNameProfiles(config);
    const profile = profiles.find((item) => item.name === "M. J. Hearth");

    expect(profile).toMatchObject({
      lane: "cozy practical home guides",
      readerPromise: "warm books that make household systems feel doable",
      inProgressCount: 1,
    });
    expect(profile?.books.inProgress[0]).toMatchObject({
      id: plan.runId,
      title: plan.title,
    });
  });

  it("enforces optimistic version checks when saving dashboard edits", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about a dock auditor", liveModel: false },
    });

    const saved = await saveBookPlan({
      config,
      plan: { ...plan, title: "A Better Title" },
      baseVersion: plan.version,
      action: "test-save",
      summary: "Testing version increment.",
    });

    expect(saved.version).toBe(plan.version + 1);
    await expect(
      saveBookPlan({
        config,
        plan: { ...saved, title: "Stale Title" },
        baseVersion: plan.version,
        action: "stale-save",
        summary: "Should fail.",
      }),
    ).rejects.toThrow("version conflict");
  });

  it("drafts empty unlocked paragraphs while preserving locked or edited Book Text", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original guide to local AI publishing workflows", liveModel: false },
    });
    const lockedText = "This hand-edited paragraph must stay exactly as written.";
    const editedText = "This unlocked editor paragraph must stay exactly as written.";
    const edited = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? {
                ...chapter,
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 0
                    ? { ...paragraph, text: lockedText, locked: true, status: "approved" }
                    : paragraphIndex === 1
                      ? { ...paragraph, text: editedText, locked: false, status: "drafted" }
                      : paragraph,
                ),
              }
            : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "lock",
      summary: "Lock first paragraph.",
    });

    const drafted = await draftAndSaveBookPlan({
      config,
      runId: edited.runId,
      baseVersion: edited.version,
      fetchImpl: bookTextFetch(),
    });
    const firstParagraph = drafted.chapters[0].paragraphs[0];
    const secondParagraph = drafted.chapters[0].paragraphs[1];
    const thirdParagraph = drafted.chapters[0].paragraphs[2];

    expect(firstParagraph.text).toBe(lockedText);
    expect(secondParagraph.text).toBe(editedText);
    expect(thirdParagraph.text.length).toBeGreaterThan(100);
    expect(thirdParagraph.text).not.toContain("The paragraph should");
    expect(thirdParagraph.text).not.toContain("Chapter focus:");
    expect(looksLikeInstructionalBookText(thirdParagraph.text)).toBe(false);
    expect(thirdParagraph.transitionIn).toContain("Continue naturally");
    expect(thirdParagraph.transitionOut).toContain("Create forward motion");
    expect(thirdParagraph.continuityObligations?.join(" ")).toContain("Bridge around locked");
    expect(thirdParagraph.revisionStatus).toBe("clean");
    expect(buildBookPlanQualityReport(drafted).status).toBe("pass");
  });

  it("drafts with chapter-window context instead of isolated paragraph context", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original clean mystery about Mara finding a fake bridge invoice",
        liveModel: false,
      },
    });
    const prompts: string[] = [];

    await draftAndSaveBookPlanParagraph({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
      paragraphId: plan.chapters[0].paragraphs[0].id,
      fetchImpl: capturingBookTextFetch(prompts),
    });

    expect(prompts[0]).toContain("Chapter drafting window:");
    expect(prompts[0]).toContain("Chapter beat map:");
    expect(prompts[0]).toContain("Chapter draft so far:");
    expect(prompts[0]).toContain("Whole-book canon:");
    expect(prompts[0]).toContain("Scene beat:");
    expect(prompts[0]).toContain("Locked constraints:");
  });

  it("drafts a chapter window in one model call and maps text back to paragraph cards", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original clean mystery about batch drafting around one bridge invoice clue",
        liveModel: false,
      },
    });
    const prompts: string[] = [];

    const drafted = await draftAndSaveBookPlan({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
      fetchImpl: chapterBatchFetch(prompts),
    });

    expect(prompts[0]).toContain("Draft a coherent multi-paragraph chapter window");
    expect(prompts[0]).toContain("Return shape:");
    expect(drafted.chapters[0].paragraphs[0].text).toContain("batch paragraph 1");
    expect(drafted.chapters[0].paragraphs[1].text).toContain("batch paragraph 2");
    expect(drafted.chapters[0].paragraphs[0].continuityObligations?.join(" ")).toContain(
      "multi-paragraph chapter-window generation",
    );
    expect(looksLikeInstructionalBookText(drafted.chapters[0].paragraphs[0].text)).toBe(false);
  });

  it("drafts and stitches a cohesive multi-chapter story while preserving locked text exactly", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const prompts: string[] = [];
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "An original clean mystery novella about Mara Vale exposing a forged bridge invoice before the town council vote.",
        targetWords: 1500,
        genre: "Clean mystery",
        liveModel: false,
      },
    });
    const lockedText =
      "Mara locks the original ledger page in her blue evidence folder and writes the bridge bolt number beside the forged invoice total.";
    const lockedPlan = await saveBookPlan({
      config,
      baseVersion: plan.version,
      action: "seed-locked-cohesion-acceptance",
      summary: "Seed locked text for full-manuscript cohesion proof.",
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? Object.assign({}, chapter, {
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 1
                    ? Object.assign({}, paragraph, {
                        text: lockedText,
                        locked: true,
                        status: "drafted" as const,
                      })
                    : paragraph,
                ),
              })
            : chapter,
        ),
      },
    });

    const drafted = await draftAndSaveBookPlan({
      config,
      runId: lockedPlan.runId,
      baseVersion: lockedPlan.version,
      fetchImpl: chapterBatchFetch(prompts),
    });
    const stitched = await stitchAndSaveBookPlan({
      config,
      runId: drafted.runId,
      baseVersion: drafted.version,
    });
    const finalReport = buildFinalCohesionReport(stitched.plan);
    const memory = buildHierarchicalMemory(stitched.plan);
    const allParagraphs = stitched.plan.chapters.flatMap((chapter) => chapter.paragraphs);

    expect(stitched.plan.chapters).toHaveLength(3);
    expect(allParagraphs.every((paragraph) => paragraph.text.trim())).toBe(true);
    expect(stitched.manuscript).toContain(lockedText);
    expect(allParagraphs.find((paragraph) => paragraph.locked)?.text).toBe(lockedText);
    expect(memory.bookBible.mainStoryline).toContain("wants");
    expect(memory.lockedTextMap[0].exactText).toBe(lockedText);
    expect(prompts.some((prompt) => prompt.includes("Final-chapter resolution contract"))).toBe(
      true,
    );
    expect(
      prompts.some((prompt) => prompt.includes("Do not introduce a new unresolved threat")),
    ).toBe(true);
    expect(finalReport.status).toBe("pass");
    expect(finalReport.findings.every((finding) => finding.status !== "fail")).toBe(true);
  });

  it("audits generated chapter windows and records repair guidance around adjacent locks", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original clean mystery about locked clue integration",
        liveModel: false,
      },
    });
    const lockedText =
      'Mara held up the invoice and said, "This signature was copied after the inspection."';
    const locked = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? {
                ...chapter,
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 1
                    ? { ...paragraph, text: lockedText, locked: true, status: "approved" }
                    : paragraph,
                ),
              }
            : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "seed-adjacent-lock",
      summary: "Seed adjacent locked clue.",
    });

    const drafted = await draftAndSaveBookPlanParagraph({
      config,
      runId: locked.runId,
      baseVersion: locked.version,
      paragraphId: locked.chapters[0].paragraphs[0].id,
      fetchImpl: bookTextFetch(
        "Mara stepped onto the bridge with the contract folder under one arm, watching rain collect along the rivets while the council clock pushed toward noon. She followed the invoice trail with clean suspense, remembered the copied dates in the maintenance log, and slowed her breathing until the locked clue ahead felt earned. By the time she reached the council door, every quiet detail pointed toward the signature waiting in the next moment, and the transition into that fixed clue now felt deliberate, earned, and unavoidable.",
      ),
    });
    const repaired = drafted.chapters[0].paragraphs[0];
    expect(repaired.revisionStatus).toBe("clean");
    expect(repaired.transitionOut).toContain("Prepare the locked paragraph");
    expect(repaired.continuityObligations?.join(" ")).toContain("QA repair");

    const revisionMap = JSON.parse(
      await fs.readFile(path.join(outputDir, plan.runId, "revision-map.json"), "utf8"),
    ) as { issues: Array<{ code: string; paragraphId: string }> };
    expect(revisionMap.issues).toEqual([]);
  });

  it("drafts one paragraph only when AI write this is requested", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original guide to paragraph-level book control", liveModel: false },
    });
    const target = plan.chapters[0].paragraphs[0];

    const drafted = await draftAndSaveBookPlanParagraph({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
      paragraphId: target.id,
      fetchImpl: bookTextFetch(),
    });

    expect(drafted.chapters[0].paragraphs[0].text.length).toBeGreaterThan(100);
    expect(drafted.chapters[0].paragraphs[0].text).not.toContain("The book is about");
    expect(looksLikeInstructionalBookText(drafted.chapters[0].paragraphs[0].text)).toBe(false);
    expect(drafted.chapters[0].paragraphs[1].text).toBe("");
    await expect(
      draftAndSaveBookPlanParagraph({
        config,
        runId: drafted.runId,
        baseVersion: drafted.version,
        paragraphId: target.id,
      }),
    ).rejects.toThrow("already has Book Text");

    const rewritten = await draftAndSaveBookPlanParagraph({
      config,
      runId: drafted.runId,
      baseVersion: drafted.version,
      paragraphId: target.id,
      replaceExisting: true,
      fetchImpl: bookTextFetch(
        "On a rainy street, Aleksander made a fresh choice while Hot-N-Ready rattled the windows, and the whole block seemed to hold its breath. He stepped toward the smell instead of away from it, carrying concrete danger, clean language, and a changed decision into the next moment.",
      ),
    });
    expect(rewritten.chapters[0].paragraphs[0].text.length).toBeGreaterThan(100);
  });

  it("flags and repairs old instruction-like Book Text", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "A practical, original field guide for families who want resilient home routines without fearmongering",
        liveModel: false,
      },
    });
    const oldInstructionText =
      "Advance one argument, clue, scene beat, or practical insight. Chapter focus: Open the book with the central problem and the reader promise. The book is about A practical field guide. The paragraph should make one clear move.";
    const saved = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? {
                ...chapter,
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 0
                    ? { ...paragraph, text: oldInstructionText, status: "drafted" }
                    : paragraph,
                ),
              }
            : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "seed-old-instructions",
      summary: "Seed old instruction-like text.",
    });

    const badQuality = buildBookPlanQualityReport(saved);
    expect(badQuality.status).toBe("fail");
    expect(badQuality.findings).toContainEqual(
      expect.objectContaining({
        code: "reader-facing-text",
        status: "fail",
      }),
    );

    const repaired = await draftAndSaveBookPlan({
      config,
      runId: saved.runId,
      baseVersion: saved.version,
      fetchImpl: bookTextFetch(),
    });
    const repairedText = repaired.chapters[0].paragraphs[0].text;
    expect(repairedText).not.toBe(oldInstructionText);
    expect(repairedText).not.toContain("The paragraph should");
    expect(repairedText).not.toContain("Chapter focus:");
    expect(looksLikeInstructionalBookText(repairedText)).toBe(false);
    expect(buildBookPlanQualityReport(repaired).status).toBe("pass");
  });

  it("rejects meta prose that sounds like AI instructions", () => {
    const reportedText =
      "A useful book on A malicious toot that was created by a 10 year old boy after eating a Little Caesar's Hot-N-Ready cheese pizza creates chaos for a family and their community has to begin in an ordinary moment, because that is where pressure usually shows up first.";

    expect(looksLikeInstructionalBookText(reportedText)).toBe(true);
  });

  it("does not save fallback Book Text when the local model is unavailable", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic:
          "A malicious toot created by ten-year-old Aleksander after a Hot-N-Ready cheese pizza becomes self-aware, attacks humanity, and forces Aleksander toward Tootageddon.",
        liveModel: false,
      },
    });
    const unavailableFetch = vi.fn(async () => {
      throw new Error("LM Studio is not running");
    }) as typeof fetch;

    await expect(
      draftAndSaveBookPlan({
        config,
        runId: plan.runId,
        baseVersion: plan.version,
        fetchImpl: unavailableFetch,
      }),
    ).rejects.toThrow("AI did not return publishable prose. Nothing was changed.");

    const unchanged = await readBookPlan(config, plan.runId);
    expect(unchanged?.chapters[0].paragraphs[0].text).toBe("");
  });

  it("uses the evil-toot context as final reader-facing prose", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const topic =
      "A malicious toot that was created by a 10 year old boy after eating a Little Caesar's Hot-N-Ready cheese pizza creates chaos for a family and their community. The toot is self aware and attacks humanity. The boy's name is Aleksander. The evil toot calls itself Hot-N-Ready. The final battle is called Tootageddon.";
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic, liveModel: false },
    });
    const drafted = await draftAndSaveBookPlanParagraph({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
      paragraphId: plan.chapters[0].paragraphs[0].id,
      fetchImpl: bookTextFetch(
        "On a damp Thursday evening, ten-year-old Aleksander sat beside the greasy pizza box while Hot-N-Ready gathered in the room with a rotten patience that made the windows tremble. He laughed until the smell seemed to answer him, and then the first frightened shout from the kitchen told him his joke had learned how to hunt.",
      ),
    });
    const text = drafted.chapters[0].paragraphs[0].text;

    expect(text).toContain("Aleksander");
    expect(text).toContain("Hot-N-Ready");
    expect(text).toContain("pizza");
    expect(looksLikeInstructionalBookText(text)).toBe(false);
  });

  it("blocks stitching when any Book Text still looks like planning instructions", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original guide to reader-facing text checks", liveModel: false },
    });
    const saved = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter, chapterIndex) =>
          chapterIndex === 0
            ? {
                ...chapter,
                paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                  paragraphIndex === 0
                    ? {
                        ...paragraph,
                        text: "This paragraph should explain what AI will write for readers.",
                        status: "drafted",
                      }
                    : paragraph,
                ),
              }
            : chapter,
        ),
      },
      baseVersion: plan.version,
      action: "seed-instructional-text",
      summary: "Seed instruction-like text.",
    });

    await expect(
      stitchAndSaveBookPlan({
        config,
        runId: saved.runId,
        baseVersion: saved.version,
      }),
    ).rejects.toThrow("still looks like Plan for AI");
  });

  it("suggests an initial setup description without creating a plan", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });

    const suggestion = await suggestBookSetupTopicWithContext({
      config,
      topic: "A funny adventure about a boy and an evil pizza toot",
      targetWords: 12000,
      tonePreset: "humorous",
      profanityLevel: "none",
      intent: "improve",
      fetchImpl: bookTextFetch(
        "A humorous middle-grade adventure about Aleksander, a ten-year-old boy whose Little Caesars pizza night accidentally creates Hot-N-Ready, a self-aware evil toot that turns from secret friend into world-threatening stink monster.",
      ),
    });

    expect(suggestion.runId).toBe("new-book-draft");
    expect(suggestion.target).toBe("topic");
    expect(suggestion.engine).toBe("live-model");
    expect(suggestion.suggestion).toContain("Aleksander");
    expect(suggestion.suggestion).toContain("Hot-N-Ready");
    expect(await fs.readdir(outputDir)).toEqual([]);
  });

  it("suggests context-aware reader-facing Book Text for one paragraph", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original practical book about family emergency routines",
        liveModel: false,
      },
    });
    const lockedPlan = {
      ...plan,
      chapters: plan.chapters.map((chapter, chapterIndex) =>
        chapterIndex === 0
          ? {
              ...chapter,
              role: {
                storyThread: "side-story" as const,
                plotJob: "clue" as const,
                readerFeeling: "suspenseful" as const,
                notes: "The routine secretly reveals the missing supply clue.",
              },
              paragraphs: chapter.paragraphs.map((paragraph, paragraphIndex) =>
                paragraphIndex === 1
                  ? {
                      ...paragraph,
                      text: "The locked emergency checklist stays exactly where the family can see it.",
                      locked: true,
                    }
                  : paragraph,
              ),
            }
          : chapter,
      ),
    };
    const suggestion = await suggestBookPlanFieldWithContext({
      config,
      plan: lockedPlan,
      target: "paragraphText",
      intent: "humorous",
      chapterId: lockedPlan.chapters[0].id,
      paragraphId: lockedPlan.chapters[0].paragraphs[0].id,
      fetchImpl: bookTextFetch(
        "The supply shelf looked innocent until Aleksander noticed the missing can opener, a tiny clue with the nerve to act casual. A thread of light wit cut the fear without breaking it, and the local style accent kept the family moving toward the locked checklist instead of away from it.",
      ),
    });

    expect(suggestion.contextSummary).toContain(plan.title);
    expect(suggestion.contextSummary).toContain("After:");
    expect(suggestion.contextSummary).toContain("side story");
    expect(suggestion.lockedContext?.join(" ")).toContain("locked emergency checklist");
    expect(suggestion.suggestion).toContain("local style accent");
    expect(suggestion.suggestion).toContain("light wit");
    expect(looksLikeInstructionalBookText(suggestion.suggestion)).toBe(false);
  });

  it("stitches only manuscript-facing text and leaves editor paragraph titles out", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about a warehouse auditor", liveModel: false },
    });
    const drafted = await draftAndSaveBookPlan({
      config,
      runId: plan.runId,
      fetchImpl: chapterBatchFetch([]),
    });

    const result = await stitchAndSaveBookPlan({
      config,
      runId: drafted.runId,
      baseVersion: drafted.version,
    });

    expect(result.manuscript).toContain(`# ${drafted.title}`);
    expect(result.manuscript).toContain(`## Chapter 1: ${drafted.chapters[0].title}`);
    expect(result.manuscript).not.toContain(drafted.chapters[0].paragraphs[0].title);
    await expect(fs.stat(result.manuscriptPath)).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, drafted.runId, "final-cohesion-report.json")),
    ).resolves.toBeTruthy();
  });

  it("blocks stitching when final manuscript cohesion still has unresolved repair flags", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: {
        topic: "An original clean mystery about unresolved final cohesion",
        liveModel: false,
      },
    });
    const seeded = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter) => ({
          ...chapter,
          paragraphs: chapter.paragraphs.map((paragraph) => ({
            ...paragraph,
            text: "Mara followed the bridge invoice through the town archive with enough concrete detail, clean suspense, and consequence to keep the mystery connected across the chapter.",
            status: "drafted",
            revisionStatus:
              paragraph.id === plan.chapters[0].paragraphs[0].id ? "needs-context-repair" : "clean",
          })),
        })),
      },
      baseVersion: plan.version,
      action: "seed-unresolved-cohesion",
      summary: "Seed unresolved final cohesion issue.",
    });

    const report = buildFinalCohesionReport(seeded);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "unresolved-revision-map",
        status: "fail",
      }),
    );
    await expect(
      stitchAndSaveBookPlan({
        config,
        runId: seeded.runId,
        baseVersion: seeded.version,
      }),
    ).rejects.toThrow("final cohesion audit failed");
  });

  it("scores mystery genre excellence and blocks missing clue payoff before stitching", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about a missing city permit", liveModel: false },
    });
    const weak = await saveBookPlan({
      config,
      plan: {
        ...plan,
        chapters: plan.chapters.map((chapter) => ({
          ...chapter,
          paragraphs: chapter.paragraphs.map((paragraph) => ({
            ...paragraph,
            text: "Mara walked through town and thought about the weather, the sidewalk, and the quiet afternoon without finding anything concrete or delivering a satisfying ending for readers.",
            status: "drafted",
            revisionStatus: "clean",
            transitionIn: "Continue the scene.",
            transitionOut: "Move to the next moment.",
          })),
        })),
      },
      baseVersion: plan.version,
      action: "seed-weak-mystery",
      summary: "Seed weak mystery genre draft.",
    });

    const report = buildGenreExcellenceReport(weak);
    expect(report.genreFamily).toBe("mystery");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "mystery-payoff",
        status: "fail",
      }),
    );
    await expect(
      stitchAndSaveBookPlan({
        config,
        runId: weak.runId,
        baseVersion: weak.version,
      }),
    ).rejects.toThrow("genre excellence audit failed");
  });

  it("reorders chapters and paragraphs while renumbering them on save", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original local AI operations book", liveModel: false },
    });
    const secondChapterId = plan.chapters[1].id;
    const secondParagraphId = plan.chapters[0].paragraphs[1].id;

    const chapterMoved = await reorderChapter({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
      chapterId: secondChapterId,
      direction: "up",
    });
    expect(chapterMoved.chapters[0].id).toBe(secondChapterId);
    expect(chapterMoved.chapters[0].number).toBe(1);

    const paragraphMoved = await reorderParagraph({
      config,
      runId: chapterMoved.runId,
      baseVersion: chapterMoved.version,
      chapterId: chapterMoved.chapters[1].id,
      paragraphId: secondParagraphId,
      direction: "up",
    });
    expect(paragraphMoved.chapters[1].paragraphs[0].id).toBe(secondParagraphId);
    expect(paragraphMoved.chapters[1].paragraphs[0].order).toBe(1);
  });

  it("creates a Quick Read Edition that maps back to source paragraph ids", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const source = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about invoice fraud", liveModel: false },
    });

    const quickRead = await createQuickReadAndSave({ config, sourceRunId: source.runId });
    const reloaded = await readBookPlan(config, quickRead.runId);

    expect(quickRead.kind).toBe("quick-read");
    expect(quickRead.sourceRunId).toBe(source.runId);
    expect(quickRead.title).toContain("Quick Read Edition");
    expect(reloaded?.chapters[0].paragraphs[0].sourceParagraphIds).toEqual(
      source.chapters[0].paragraphs.map((paragraph) => paragraph.id),
    );
  });

  it("deletes a book plan from the active library without destroying recovery files", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about a library ledger", liveModel: false },
    });

    const deleted = await deleteBookPlan({
      config,
      runId: plan.runId,
      now: new Date("2026-05-22T12:00:00Z"),
    });
    const projects = await listBookPlanProjects(config);

    expect(deleted.runId).toBe(plan.runId);
    expect(projects).toHaveLength(0);
    await expect(readBookPlan(config, plan.runId)).resolves.toBeUndefined();
    await expect(fs.stat(path.join(deleted.deletedDir, "book-plan.json"))).resolves.toBeTruthy();
    const tombstone = JSON.parse(
      await fs.readFile(path.join(deleted.deletedDir, "deleted-book.json"), "utf8"),
    ) as { runId: string; title: string; deletedAt: string };
    expect(tombstone).toMatchObject({
      runId: plan.runId,
      title: plan.title,
      deletedAt: "2026-05-22T12:00:00.000Z",
    });
  });

  it("lists and restores deleted book plans back into the active library", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about a recoverable ledger", liveModel: false },
    });
    const deleted = await deleteBookPlan({
      config,
      runId: plan.runId,
      now: new Date("2026-05-22T12:00:00Z"),
    });

    const deletedBooks = await listDeletedBookPlanProjects(config);
    expect(deletedBooks).toEqual([
      expect.objectContaining({
        deletedId: deleted.deletedId,
        runId: plan.runId,
        title: plan.title,
        deletedAt: "2026-05-22T12:00:00.000Z",
      }),
    ]);

    const restored = await restoreDeletedBookPlan({ config, deletedId: deleted.deletedId });
    const projects = await listBookPlanProjects(config);

    expect(restored.runId).toBe(plan.runId);
    expect(projects.map((project) => project.runId)).toEqual([plan.runId]);
    expect(await listDeletedBookPlanProjects(config)).toHaveLength(0);
    await expect(fs.stat(path.join(outputDir, plan.runId, "deleted-book.json"))).rejects.toThrow();
  });

  it("archives drafts, restores them, and safely deletes archived books through Recently Deleted", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about an archived ledger", liveModel: false },
    });

    const archived = await archiveBookPlan({
      config,
      runId: plan.runId,
      now: new Date("2026-05-22T12:10:00Z"),
    });

    expect(await listBookPlanProjects(config)).toHaveLength(0);
    expect(await listArchivedBookPlanProjects(config)).toEqual([
      expect.objectContaining({
        archivedId: archived.archivedId,
        runId: plan.runId,
        title: plan.title,
        archivedAt: "2026-05-22T12:10:00.000Z",
      }),
    ]);

    const restored = await restoreArchivedBookPlan({
      config,
      archivedId: archived.archivedId,
    });
    expect(restored.runId).toBe(plan.runId);
    expect((await listBookPlanProjects(config)).map((project) => project.runId)).toEqual([
      plan.runId,
    ]);

    const archivedAgain = await archiveBookPlan({
      config,
      runId: plan.runId,
      now: new Date("2026-05-22T12:11:00Z"),
    });
    const deleted = await deleteArchivedBookPlan({
      config,
      archivedId: archivedAgain.archivedId,
      now: new Date("2026-05-22T12:12:00Z"),
    });

    expect(await listArchivedBookPlanProjects(config)).toHaveLength(0);
    expect((await listDeletedBookPlanProjects(config)).map((book) => book.deletedId)).toEqual([
      deleted.deletedId,
    ]);
    await expect(
      fs.stat(path.join(outputDir, "_deleted-books", deleted.deletedId, "deleted-book.json")),
    ).resolves.toBeTruthy();
  });

  it("copies editable drafts without carrying publish artifacts or trophy proof", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about a copied ledger", liveModel: false },
    });
    const drafted = await draftAndSaveBookPlanParagraph({
      config,
      runId: plan.runId,
      paragraphId: plan.chapters[0].paragraphs[0].id,
      fetchImpl: bookTextFetch(),
    });
    const copied = await copyBookPlan({
      config,
      runId: drafted.runId,
      now: new Date("2026-05-22T12:20:00Z"),
    });

    expect(copied.runId).not.toBe(drafted.runId);
    expect(copied.title).toBe(`Copy of ${drafted.title}`);
    expect(copied.chapters[0].paragraphs[0].text).toBe(drafted.chapters[0].paragraphs[0].text);
    expect(copied.artifactLinks).not.toHaveProperty("kdpDryRunReport");
    expect(await readBookPlan(config, drafted.runId)).toBeTruthy();
    expect(await readBookPlan(config, copied.runId)).toBeTruthy();
  });

  it("creates and approves an AI cover concept before publishing prep", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original practical book about cover workflow", liveModel: false },
    });

    expect(plan.cover.status).toBe("generated");
    expect(plan.cover.variants[0]).toMatchObject({
      id: "auto-concept",
      label: "Editable SVG concept",
      source: "svg-concept",
      approved: false,
    });
    await expect(
      fs.stat(path.join(outputDir, plan.runId, "cover-concept.svg")),
    ).resolves.toBeTruthy();

    const regenerated = await generateAndSaveBookPlanCoverConcept({
      config,
      runId: plan.runId,
      baseVersion: plan.version,
    });
    const approved = await approveBookPlanCover({
      config,
      runId: regenerated.runId,
      baseVersion: regenerated.version,
      variantId: "auto-concept",
    });

    expect(approved.cover.status).toBe("approved");
    expect(approved.cover.variants.find((variant) => variant.id === "auto-concept")?.approved).toBe(
      true,
    );
    expect(approved.artifactLinks.approvedCover).toContain("cover-concept.svg");
  });

  it("permanently deletes one or all recently deleted book plans", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const first = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about a permanent ledger", liveModel: false },
    });
    const second = await createAndSaveBookPlan({
      config,
      request: { topic: "An original practical book about deleted shelves", liveModel: false },
    });
    const firstDeleted = await deleteBookPlan({
      config,
      runId: first.runId,
      now: new Date("2026-05-22T12:00:00Z"),
    });
    const secondDeleted = await deleteBookPlan({
      config,
      runId: second.runId,
      now: new Date("2026-05-22T12:01:00Z"),
    });

    await deleteDeletedBookPlan({ config, deletedId: firstDeleted.deletedId });
    expect((await listDeletedBookPlanProjects(config)).map((book) => book.deletedId)).toEqual([
      secondDeleted.deletedId,
    ]);
    await expect(fs.stat(firstDeleted.deletedDir)).rejects.toThrow();
    await expect(deleteDeletedBookPlan({ config, deletedId: "../bad" })).rejects.toThrow(
      "deletedId is invalid",
    );

    await emptyDeletedBookPlans({ config });

    expect(await listDeletedBookPlanProjects(config)).toHaveLength(0);
    await expect(fs.stat(secondDeleted.deletedDir)).rejects.toThrow();
  });

  it("moves completed books into the finished trophy room with their publishing cover", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir });
    const plan = await createAndSaveBookPlan({
      config,
      request: { topic: "An original clean mystery about a finished ledger", liveModel: false },
    });
    const coverPath = path.join(outputDir, plan.runId, "cover.tiff");
    const packaged = await saveBookPlan({
      config,
      plan: {
        ...plan,
        status: "publish-ready",
        artifactLinks: {
          ...plan.artifactLinks,
          cover: coverPath,
        },
      },
      baseVersion: plan.version,
      action: "test-cover",
      summary: "Attach cover artifact for finished shelf.",
    });

    const finished = await finishBookPlan({
      config,
      runId: packaged.runId,
      now: new Date("2026-05-22T12:30:00Z"),
      proof: {
        destination: "amazon-kdp",
        publishedAt: "2026-05-22",
        operatorConfirmed: true,
      },
    });
    const projects = await listBookPlanProjects(config);
    const finishedBooks = await listFinishedBookPlanProjects(config);

    expect(projects).toHaveLength(0);
    expect(await readBookPlan(config, packaged.runId)).toBeUndefined();
    expect(finished.coverSource).toBe("plan cover");
    expect(finished.coverPath).toBe(path.join(finished.finishedDir, "cover.tiff"));
    expect(finishedBooks).toEqual([
      expect.objectContaining({
        finishedId: finished.finishedId,
        runId: packaged.runId,
        title: packaged.title,
        finishedAt: "2026-05-22T12:30:00.000Z",
        coverPath: path.join(finished.finishedDir, "cover.tiff"),
        coverSource: "plan cover",
        metrics: expect.objectContaining({ totalSales: 0, totalProfitUsd: 0 }),
        publishProof: expect.objectContaining({ destination: "amazon-kdp" }),
      }),
    ]);

    const recommendation = recommendNextBookFromPublishedBooks([
      {
        ...finishedBooks[0],
        metrics: {
          totalSales: 42,
          totalRevenueUsd: 210,
          totalProfitUsd: 120,
          adSpendUsd: 20,
          snapshots: [],
        },
      },
    ]);
    expect(recommendation?.topicParagraph).toContain(packaged.genre);

    const restored = await restoreFinishedBookPlan({ config, finishedId: finished.finishedId });
    expect(restored.runId).toBe(packaged.runId);
    expect((await listBookPlanProjects(config)).map((project) => project.runId)).toEqual([
      packaged.runId,
    ]);
    expect(await listFinishedBookPlanProjects(config)).toHaveLength(0);
    await expect(
      fs.stat(path.join(outputDir, packaged.runId, "finished-book.json")),
    ).rejects.toThrow();
  });
});
