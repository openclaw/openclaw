# Prompt To ROM Workflow

1. User prompt becomes PCC project intent.
2. GPT 5.5 high-reasoning writes the blueprint and quality rubric.
3. PCC validates legal and hardware constraints.
4. Local workers propose bounded JSON patches for level, gameplay, art, audio, and hardware planning.
5. Deterministic scripts validate and integrate accepted patches.
6. Engine and asset compilers build SNES-safe source data.
7. The ROM build runs, then SuperFamicheck and budget checks run.
8. Emulator screenshot/replay and runtime asset truth prove the ROM contains the intended content.
9. Human visual approval gates production art.
10. Package/export runs only after required receipts pass.

If a step fails, PCC creates a repair task and preserves the exact blocker.
