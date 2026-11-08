# Warm-reload harness calibration (2026-11-07)

## Shared annotation cost

The original comparisons below retain the full text-annotation observer in every
arm, including the collector called minimal. They cannot measure that shared cost.
A bounded annotator must first reproduce both rows and Details Element Timing in
the same capture as the full annotator. Then compare full versus lean annotation
on one build in steady timing mode: eight alternating pairs plus A/A for native
active, native archived and Team active; report within-order effects for rows,
FCP, pane start and LoAF. Re-baseline all four workloads with twelve lean reloads.
Keep the CLI and report shape stable; the bottom-paragraph marker remains visual
proof only. A marker-time mismatch stops adoption rather than redefining the gate.

The standard Team sampler has a measurable rows cost; the reduced collector does not show a consistent additional rows cost. A steady timing-only Team reload passes the 480 ms text-paint prerequisite. This does **not** establish complete-frame visual qualification or approve a visibility join.

## Fixed setup

- One quiet AWS `c7a.4xlarge`, 16 vCPU, about 31 GiB, lease `cbx_95fb8436562f`.
- One application build of `636fc28d8bbd11a3ba91569b2bb250339fa21a45` (tooling bootstrap adds documentation only). Repo-pinned full headless Chromium 156.0.8078.4; 1720 × 1180 viewport. No CPU sampler in timed or trace captures.
- Same synthetic fixtures, bundle and state owners for every arm. Team uses the real old-page `--paint-holding` path, live-fast latency, active witness and populated Details; native uses signed-in admission, real `page.reload()`, 80 ms CDP latency and the corresponding active/archived native fixture. These workloads have different admission, transport and persistence costs; their absolute difference is not a provider or app regression.
- A common postbuild User Timing mark at the `MountedPane` continuation records pane start in every arm. Its compressed bundle sidecars were regenerated before formal captures. No application source changed. Team observation window was 2200 ms, native 1800 ms; post-window readiness can extend the recorded LoAF window. Rows, FCP, pane and hello precede these windows.
- Eight alternating AB/BA pairs and eight matching minimal/minimal A/A pairs per comparison. Positive tax means the named harness is slower. Within each order, subtract the A/A median from minimal-minus-harness; negate the mean of the two adjusted effects for tax. Raw counts are diagnostics, not gates.

The minimal collector annotates direct transcript/Details text owners for Element Timing and buffers Paint Timing, marks and native LoAF entries; it subscribes to the existing hello owner. It reads after the window, without continuous geometry, screencast, census, CPU profiling or readiness queries on the paint path. Standard retains the existing rAF samplers. Reduced retains the earlier timestamp/IDB/font/mutation wrappers, the benchmark presentation observer and eager readiness checks, while omitting the main continuous warm-geometry sampler. The common Team fixture transport and admission owner remain installed in every arm; census here means the additional external RPC probe. Visual is minimal plus compositor screencast and RPC census, including post-window pixel analysis.

## Probe tax

All times are milliseconds; brackets are IQR. AB/BA effects are **minimal minus harness** after same-order A/A subtraction; tax reverses their sign.

| Harness         | Metric |              Harness |              Minimal | Adjusted tax | AB effect | BA effect |
| --------------- | ------ | -------------------: | -------------------: | -----------: | --------: | --------: |
| team-standard   | rows   | 472.0 [467.0, 484.0] | 462.0 [456.0, 465.0] |         16.0 |     -18.0 |     -14.0 |
| team-standard   | fcp    | 110.0 [104.0, 185.0] | 108.0 [107.0, 132.0] |         -1.0 |     -28.0 |      30.0 |
| team-standard   | pane   | 271.0 [264.8, 279.9] | 266.4 [262.5, 269.7] |         13.9 |     -18.1 |      -9.8 |
| team-standard   | hello  | 553.7 [548.4, 557.4] | 537.6 [535.6, 539.4] |         20.0 |     -22.0 |     -18.0 |
| team-standard   | loaf   | 202.4 [195.2, 207.8] | 182.1 [175.4, 189.3] |         17.4 |     -12.8 |     -22.0 |
| team-reduced    | rows   | 458.0 [452.0, 472.0] | 456.0 [452.0, 460.0] |        -10.0 |      16.0 |       4.0 |
| team-reduced    | fcp    | 154.0 [114.0, 188.0] | 114.0 [103.0, 178.0] |         16.0 |       4.0 |     -36.0 |
| team-reduced    | pane   | 267.6 [260.5, 269.1] | 262.0 [258.4, 265.2] |         -3.2 |      -0.7 |       7.2 |
| team-reduced    | hello  | 542.4 [539.9, 544.7] | 536.1 [532.3, 540.2] |         -3.1 |       1.2 |       5.1 |
| team-reduced    | loaf   | 185.8 [180.0, 190.4] | 179.2 [175.8, 184.0] |          4.9 |      10.8 |     -20.5 |
| team-visual     | rows   | 464.0 [431.0, 497.0] | 484.0 [451.0, 501.0] |        -30.0 |      88.0 |     -28.0 |
| team-visual     | fcp    | 128.0 [123.0, 137.0] | 112.0 [108.0, 129.0] |         -1.0 |     -12.0 |      14.0 |
| team-visual     | pane   | 254.2 [226.1, 280.3] | 296.6 [264.9, 315.5] |        -48.6 |      93.9 |       3.3 |
| team-visual     | hello  | 556.7 [543.5, 591.0] | 566.4 [538.4, 582.8] |          2.7 |       6.1 |     -11.5 |
| team-visual     | loaf   | 212.9 [192.8, 226.0] | 169.4 [164.4, 186.1] |         42.0 |     -47.4 |     -36.6 |
| native-standard | rows   | 592.0 [571.0, 614.0] | 570.0 [563.0, 595.0] |          8.0 |      -6.0 |     -10.0 |
| native-standard | fcp    |    48.0 [48.0, 48.0] |    48.0 [48.0, 48.0] |         -0.0 |       0.0 |       0.0 |
| native-standard | pane   | 300.1 [272.9, 328.6] | 279.0 [275.6, 288.7] |          8.1 |      -9.8 |      -6.5 |
| native-standard | hello  | 799.5 [762.4, 802.5] | 752.0 [739.9, 781.3] |         14.2 |     -20.7 |      -7.7 |
| native-standard | loaf   | 381.1 [371.9, 398.5] | 352.0 [344.3, 366.4] |          5.0 |      -8.4 |      -1.5 |
| native-reduced  | rows   | 586.0 [580.0, 610.0] | 578.0 [572.0, 593.0] |         -3.0 |      -8.0 |      14.0 |
| native-reduced  | fcp    |    48.0 [48.0, 48.0] |    48.0 [48.0, 48.0] |         -3.0 |      -4.0 |      10.0 |
| native-reduced  | pane   | 286.9 [281.3, 318.6] | 285.8 [273.1, 307.8] |         -9.1 |      16.8 |       1.4 |
| native-reduced  | hello  | 782.8 [754.0, 794.1] | 762.8 [748.7, 794.0] |        -12.5 |       2.0 |      22.9 |
| native-reduced  | loaf   | 358.7 [355.4, 366.2] | 353.6 [346.4, 368.8] |        -10.9 |     -13.2 |      35.0 |
| native-visual   | rows   | 632.0 [620.0, 647.0] | 590.0 [575.0, 631.0] |         10.0 |     -20.0 |       0.0 |
| native-visual   | fcp    |    66.0 [64.0, 71.0] |    50.0 [48.0, 52.0] |         18.0 |     -24.0 |     -12.0 |
| native-visual   | pane   | 313.2 [299.2, 327.7] | 286.6 [277.4, 322.8] |        -22.9 |      13.9 |      31.9 |
| native-visual   | hello  | 827.1 [798.8, 851.4] | 776.4 [751.8, 819.7] |         23.9 |     -40.6 |      -7.2 |
| native-visual   | loaf   | 427.6 [386.6, 432.2] | 365.5 [345.4, 389.4] |         46.4 |     -65.1 |     -27.7 |

Team standard rows have nonoverlapping arm IQRs (467–484 versus 456–465 ms), with improvement in both adjusted orders. Its 16 ms adjusted tax exceeds the 14 ms overall A/A rows IQR spread. Its hello and LoAF results agree. Native standard rows overlap and its 8 ms adjusted tax is inside A/A noise. Reduced rows do not support a reproducible additional tax. Team visual rows have opposite order effects (+88 and −28 ms): the −30 ms scalar tax is not evidence that screencasting speeds up reloads. Visual capture does add roughly 42–46 ms of LoAF blocking. Keep timed and visual proofs separate.

## Reload ordinal and code cache

| Workload | Contexts |            #4 − #1 rows |              FCP |                    Pane |                Hello |                 LoAF |
| -------- | -------: | ----------------------: | ---------------: | ----------------------: | -------------------: | -------------------: |
| team     |        8 |    -76.0 [-84.0, -72.0] | 78.0 [1.0, 88.0] |    -72.1 [-78.2, -66.6] | -63.9 [-72.1, -53.1] | -14.7 [-19.2, -12.1] |
| native   |        8 | -158.0 [-171.0, -139.0] |  0.0 [-5.0, 4.0] | -131.3 [-144.7, -113.8] |    0.6 [-23.8, 13.8] |  -26.2 [-50.4, -5.7] |

The eight contexts reuse minimal A/A arms and independently initialized same-fixture contexts. Each comparison follows the same page and profile. Native input inventories are read-only: messages, Details, row-display hashes and store shapes stay stable; ordinary snapshot hashes change every reload and the synthetic avatar-cache storage key appears once at #2. Natural exit writers remain part of navigation. The ordinal effect therefore includes that first-return cache bookkeeping; it is not isolated causal attribution to V8 alone. These are semantically stable inputs, not byte-identical snapshots. A rejected pre-drained native experiment is excluded from every table.

One trace-only capture per ordinal 1–4 and workload uses exactly `v8,devtools.timeline`, without a CPU sampler. Main-thread production durations below are interval unions after the main document CommitLoad (nested events are not summed twice). Producer events have no module URL, so they cannot be assigned to named bundles.

| Workload              | Ordinal | Module compiles | Explicit consume | Produce before pane | Before rows | Total |
| --------------------- | ------: | --------------: | ---------------: | ------------------: | ----------: | ----: |
| team-trace-active     |       1 |              60 |                0 |                75.0 |        80.0 |  81.7 |
| team-trace-active     |       2 |              60 |               40 |                 0.0 |         0.1 |   0.1 |
| team-trace-active     |       3 |              60 |               39 |                 0.0 |         0.1 |   0.1 |
| team-trace-active     |       4 |              60 |               38 |                 0.0 |         0.1 |   0.2 |
| team-trace-archived   |       1 |              56 |                0 |                73.5 |        77.8 |  80.0 |
| team-trace-archived   |       2 |              56 |               41 |                 0.0 |         0.1 |   0.2 |
| team-trace-archived   |       3 |              56 |               42 |                 5.4 |         5.5 |   5.5 |
| team-trace-archived   |       4 |              56 |               43 |                 0.0 |         0.1 |   0.1 |
| native-trace-active   |       1 |              52 |                0 |                79.5 |        84.3 |  87.0 |
| native-trace-active   |       2 |              52 |                1 |                 0.7 |         0.7 |   0.8 |
| native-trace-active   |       3 |              52 |                1 |                 0.1 |         0.1 |   0.1 |
| native-trace-active   |       4 |              52 |                1 |                 0.1 |         0.1 |   0.1 |
| native-trace-archived |       1 |              46 |                0 |                82.7 |        86.0 |  88.6 |
| native-trace-archived |       2 |              46 |                1 |                 0.8 |         0.8 |   0.8 |
| native-trace-archived |       3 |              46 |                1 |                 0.1 |         0.1 |   0.1 |
| native-trace-archived |       4 |              46 |                1 |                 0.0 |         0.0 |   0.1 |

The consume regime starts at warm ordinal **2** and persists through #4. Team explicitly consumes 38–43 modules per reload after zero on #1. Native records one explicit main-thread module consumer and a background cache-consumer/decode sequence on each of #2–4, absent on #1. This is not proof that every module consumes cache. Large first-return production largely disappears after #1. One prime avoids measuring that first return; the conservative steady baselines below use ordinals #5–16. Team FCP becomes later across ordinals even while rows improve; priming changes the measured workload and is not an all-metric speedup.

## Cheapest metric-complete steady baseline

| Workload                 |              Rows ET |                  FCP |           Pane start |   Visible Details ET | Rows <480 |
| ------------------------ | -------------------: | -------------------: | -------------------: | -------------------: | --------: |
| team-baseline-active     | 454.0 [448.0, 461.0] | 182.0 [164.0, 188.0] | 264.3 [261.7, 269.8] | 454.0 [448.0, 461.0] |     12/12 |
| team-baseline-archived   | 408.0 [404.0, 427.0] | 184.0 [151.0, 188.0] | 260.3 [254.8, 273.2] | 408.0 [404.0, 427.0] |     12/12 |
| native-baseline-active   | 558.0 [555.0, 576.0] |    48.0 [48.0, 49.0] | 271.6 [268.7, 282.8] | 558.0 [555.0, 576.0] |      0/12 |
| native-baseline-archived | 524.0 [516.0, 528.0] |    48.0 [48.0, 48.0] | 286.9 [280.5, 295.8] | 524.0 [516.0, 528.0] |      0/12 |

Visible Details and rows ET co-frame in all 12 samples of each workload. Team active rows are reliably below 480 ms on this fixture (median 454, IQR 448–461, all 12 below); archived rows are 408 [404, 427]. Eligible text paint passes the timing prerequisite. A complete cached frame is **not established by this timing-only collector**: geometry, the composer and later section completeness still require separate inspected visual proofs. The earlier visual-harness stop is not a causal absolute-timing verdict, but this calibration does not waive its visual gate.

`BeginLifecycleUpdates` is absent from the requested trace categories. Do not fabricate that clock. The #4 trace supplies the observed main-document `CommitLoad` offset below; subtracting that single reference from the untraced baseline is an approximate translation, not a per-run lifecycle measurement or a proven paint-hold timer anchor.

| Workload                 | #4 CommitLoad offset | Rows relative to that reference | Traced #4 rows after CommitLoad |
| ------------------------ | -------------------: | ------------------------------: | ------------------------------: |
| team-baseline-active     |                 63.3 |            390.7 [384.7, 397.7] |                           392.7 |
| team-baseline-archived   |                 69.2 |            338.8 [334.8, 357.8] |                           354.8 |
| native-baseline-active   |                 22.2 |            535.8 [532.8, 553.8] |                           541.8 |
| native-baseline-archived |                 21.3 |            502.7 [494.7, 506.7] |                           518.7 |

The calibrated 500 ms hold remains a separate compositor control. Navigation-start ET, CommitLoad-relative ET and observed held-surface transitions must not be silently substituted for one another.

## Pair diagnostics and spreads

Signed deltas below are minimal minus named harness. Each array alternates AB-first and BA-first. A/A is candidate minus base. Better counts and raw medians are retained only as diagnostics.

## team-standard

| Metric | A/B pair deltas (AB, BA alternating)                 | A/A pair deltas                                   |           Raw median | Better count | Order-balanced | A/A balanced | Adjusted tax |
| ------ | ---------------------------------------------------- | ------------------------------------------------- | -------------------: | -----------: | -------------: | -----------: | -----------: |
| rows   | -80.0, -4.0, 12.0, -16.0, -36.0, -12.0, 0.0, -12.0   | -68.0, 24.0, 12.0, -4.0, -8.0, 4.0, 8.0, 0.0      |  -12.0 [-21.0, -3.0] |          6/8 |          -15.0 |          1.0 |         16.0 |
| fcp    | 4.0, 84.0, -80.0, -4.0, -20.0, 16.0, -76.0, -4.0     | 8.0, -76.0, -84.0, 24.0, 92.0, -72.0, -48.0, 84.0 |    -4.0 [-34.0, 7.0] |          5/8 |          -21.0 |        -22.0 |         -1.0 |
| pane   | -67.8, -0.0, -3.4, -9.0, -24.7, -1.4, 12.8, -6.9     | -72.8, 5.8, 3.1, 5.9, 5.1, 5.4, 9.7, 2.5          |   -5.1 [-12.9, -1.1] |          7/8 |           -9.1 |          4.8 |         13.9 |
| hello  | -85.7, -22.0, 2.0, -17.5, -24.8, -13.5, -2.2, -25.8  | -56.4, -13.3, 9.5, -6.4, 7.5, 3.0, 14.4, 6.5      | -19.8 [-25.1, -10.7] |          7/8 |          -16.6 |          3.4 |         20.0 |
| loaf   | -31.6, 13.9, -10.0, -25.0, -29.0, -30.5, -6.5, -30.8 | -4.3, 11.8, -7.3, -4.7, -10.8, -6.7, -6.1, -8.1   |  -27.0 [-30.6, -9.1] |          7/8 |          -23.6 |         -6.2 |         17.4 |

| Metric | Order | A/B delta median [IQR] | A/A delta median [IQR] | Adjusted effect |
| ------ | ----- | ---------------------: | ---------------------: | --------------: |
| rows   | AB    |     -18.0 [-47.0, 3.0] |       0.0 [-23.0, 9.0] |           -18.0 |
| rows   | BA    |   -12.0 [-13.0, -10.0] |        2.0 [-1.0, 9.0] |           -14.0 |
| fcp    | AB    |   -48.0 [-77.0, -14.0] |    -20.0 [-57.0, 29.0] |           -28.0 |
| fcp    | BA    |       6.0 [-4.0, 33.0] |    -24.0 [-73.0, 39.0] |            30.0 |
| pane   | AB    |     -14.0 [-35.5, 0.7] |       4.1 [-15.9, 6.2] |           -18.1 |
| pane   | BA    |      -4.2 [-7.4, -1.1] |         5.6 [4.7, 5.8] |            -9.8 |
| hello  | AB    |    -13.5 [-40.0, -1.2] |       8.5 [-8.5, 10.7] |           -22.0 |
| hello  | BA    |   -19.8 [-23.0, -16.5] |       -1.7 [-8.1, 3.9] |           -18.0 |
| loaf   | AB    |    -19.5 [-29.6, -9.1] |      -6.7 [-8.2, -5.6] |           -12.8 |
| loaf   | BA    |   -27.8 [-30.6, -15.3] |      -5.7 [-7.0, -0.6] |           -22.0 |

## team-reduced

| Metric | A/B pair deltas (AB, BA alternating)               | A/A pair deltas                                    |          Raw median | Better count | Order-balanced | A/A balanced | Adjusted tax |
| ------ | -------------------------------------------------- | -------------------------------------------------- | ------------------: | -----------: | -------------: | -----------: | -----------: |
| rows   | -80.0, 16.0, 0.0, -20.0, -12.0, -16.0, 0.0, 8.0    | -60.0, 16.0, -4.0, -16.0, -24.0, 0.0, -20.0, -20.0 |   -6.0 [-17.0, 2.0] |          4/8 |           -5.0 |        -15.0 |        -10.0 |
| fcp    | -12.0, -76.0, 52.0, -4.0, -8.0, -88.0, -68.0, 84.0 | -72.0, -8.0, -8.0, 0.0, -20.0, -12.0, -4.0, 8.0    | -10.0 [-70.0, 10.0] |          6/8 |          -25.0 |         -9.0 |         16.0 |
| pane   | -78.3, 6.7, -11.6, -12.1, -15.7, -4.7, 1.3, 11.1   | -65.1, -3.6, -2.2, -8.0, -8.3, -11.5, -17.6, -4.3  |   -8.2 [-13.0, 2.7] |          5/8 |           -6.3 |         -9.6 |         -3.2 |
| hello  | -65.5, -6.4, -7.6, -15.1, -11.8, 1.9, -0.2, 1.9    | -49.7, 2.7, -1.4, -14.4, -9.5, -7.4, -12.2, -7.4   |   -7.0 [-12.6, 0.3] |          6/8 |           -6.0 |         -9.1 |         -3.1 |
| loaf   | 0.6, -12.3, 5.0, -14.4, -15.7, -9.6, 34.2, -1.7    | -5.2, 22.8, 4.2, -18.6, -21.6, -3.6, -10.8, 26.1   |   -5.7 [-12.8, 1.7] |          5/8 |           -4.1 |          0.8 |          4.9 |

| Metric | Order | A/B delta median [IQR] | A/A delta median [IQR] | Adjusted effect |
| ------ | ----- | ---------------------: | ---------------------: | --------------: |
| rows   | AB    |      -6.0 [-29.0, 0.0] |   -22.0 [-33.0, -16.0] |            16.0 |
| rows   | BA    |     -4.0 [-17.0, 10.0] |      -8.0 [-17.0, 4.0] |             4.0 |
| fcp    | AB    |     -10.0 [-26.0, 7.0] |    -14.0 [-33.0, -7.0] |             4.0 |
| fcp    | BA    |    -40.0 [-79.0, 18.0] |       -4.0 [-9.0, 2.0] |           -36.0 |
| pane   | AB    |    -13.7 [-31.3, -8.4] |    -12.9 [-29.5, -6.8] |            -0.7 |
| pane   | BA    |        1.0 [-6.5, 7.8] |      -6.2 [-8.9, -4.1] |             7.2 |
| hello  | AB    |     -9.7 [-25.2, -5.8] |    -10.9 [-21.6, -7.5] |             1.2 |
| hello  | BA    |       -2.2 [-8.6, 1.9] |      -7.4 [-9.1, -4.9] |             5.1 |
| loaf   | AB    |       2.8 [-3.5, 12.3] |     -8.0 [-13.5, -2.8] |            10.8 |
| loaf   | BA    |    -10.9 [-12.8, -7.6] |       9.6 [-7.4, 23.6] |           -20.5 |

## team-visual

| Metric | A/B pair deltas (AB, BA alternating)                 | A/A pair deltas                                 |           Raw median | Better count | Order-balanced | A/A balanced | Adjusted tax |
| ------ | ---------------------------------------------------- | ----------------------------------------------- | -------------------: | -----------: | -------------: | -----------: | -----------: |
| rows   | -140.0, 52.0, 80.0, -32.0, 76.0, -24.0, 76.0, -48.0  | -64.0, 16.0, -4.0, 0.0, -20.0, 0.0, 20.0, -24.0 |   14.0 [-36.0, 76.0] |          4/8 |           24.0 |         -6.0 |        -30.0 |
| fcp    | -12.0, -64.0, -12.0, -12.0, -16.0, 32.0, -16.0, 44.0 | 0.0, -4.0, 76.0, 4.0, -4.0, -4.0, -88.0, -24.0  |  -12.0 [-16.0, -1.0] |          6/8 |           -2.0 |         -3.0 |         -1.0 |
| pane   | -131.2, 62.7, 98.6, -1.1, 93.2, 2.1, 88.2, -18.7     | -76.4, 4.0, -2.5, 3.9, -3.9, -9.4, -2.5, -16.0  |    32.4 [-5.5, 89.4] |          3/8 |           45.6 |         -3.0 |        -48.6 |
| hello  | -36.3, 31.4, -10.7, -10.9, -6.8, -3.9, 29.7, -17.7   | -63.2, 9.1, 0.1, 7.7, -19.1, -13.7, -10.7, 0.6  |    -8.8 [-12.6, 4.5] |          6/8 |           -8.1 |         -5.4 |          2.7 |
| loaf   | 2.6, -9.7, -66.0, -40.1, -55.8, -20.6, -26.2, -52.9  | 0.5, 46.5, 12.3, 7.7, -69.7, 0.1, 35.7, 4.8     | -33.1 [-53.6, -17.9] |          7/8 |          -35.7 |          6.3 |         42.0 |

| Metric | Order | A/B delta median [IQR] | A/A delta median [IQR] | Adjusted effect |
| ------ | ----- | ---------------------: | ---------------------: | --------------: |
| rows   | AB    |      76.0 [22.0, 77.0] |     -12.0 [-31.0, 2.0] |            88.0 |
| rows   | BA    |    -28.0 [-36.0, -5.0] |        0.0 [-6.0, 4.0] |           -28.0 |
| fcp    | AB    |   -14.0 [-16.0, -12.0] |     -2.0 [-25.0, 19.0] |           -12.0 |
| fcp    | BA    |     10.0 [-25.0, 35.0] |      -4.0 [-9.0, -2.0] |            14.0 |
| pane   | AB    |      90.7 [33.3, 94.5] |     -3.2 [-22.0, -2.5] |            93.9 |
| pane   | BA    |       0.5 [-5.5, 17.2] |      -2.7 [-11.0, 3.9] |             3.3 |
| hello  | AB    |      -8.8 [-17.1, 2.3] |    -14.9 [-30.1, -8.0] |             6.1 |
| hello  | BA    |      -7.4 [-12.6, 4.9] |        4.2 [-3.0, 8.0] |           -11.5 |
| loaf   | AB    |   -41.0 [-58.4, -19.0] |      6.4 [-17.1, 18.2] |           -47.4 |
| loaf   | BA    |   -30.3 [-43.3, -17.9] |        6.2 [3.6, 17.4] |           -36.6 |

## native-standard

| Metric | A/B pair deltas (AB, BA alternating)                  | A/A pair deltas                                     |           Raw median | Better count | Order-balanced | A/A balanced | Adjusted tax |
| ------ | ----------------------------------------------------- | --------------------------------------------------- | -------------------: | -----------: | -------------: | -----------: | -----------: |
| rows   | -68.0, -16.0, 32.0, -36.0, 0.0, -48.0, 36.0, -60.0    | -20.0, 0.0, 84.0, -48.0, 24.0, -40.0, 20.0, -24.0   |   -26.0 [-51.0, 8.0] |          5/8 |          -13.0 |         -5.0 |          8.0 |
| fcp    | 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0                | 12.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -12.0           |       0.0 [0.0, 0.0] |          0/8 |            0.0 |          0.0 |         -0.0 |
| pane   | -55.6, -10.4, 6.9, -30.5, -0.8, -48.0, 52.1, -67.8    | -15.1, 0.5, 6.6, -56.7, 19.1, -44.1, 33.6, -21.4    |   -20.5 [-49.9, 1.1] |          6/8 |          -18.1 |        -10.0 |          8.1 |
| hello  | -58.5, -46.7, 35.6, -51.7, 17.2, -93.2, 36.6, -66.8   | -23.6, -27.8, 98.9, -69.8, 53.4, -72.6, 40.8, -33.4 |  -49.2 [-60.6, 21.8] |          5/8 |          -16.4 |         -2.3 |         14.2 |
| loaf   | -14.7, -35.9, 17.2, -35.2, -20.9, -57.0, -13.1, -47.9 | -2.3, 3.5, 98.4, -45.3, -8.7, -51.2, -11.7, -35.5   | -28.0 [-38.9, -14.3] |          7/8 |          -27.9 |        -22.9 |          5.0 |

| Metric | Order | A/B delta median [IQR] | A/A delta median [IQR] | Adjusted effect |
| ------ | ----- | ---------------------: | ---------------------: | --------------: |
| rows   | AB    |     16.0 [-17.0, 33.0] |      22.0 [10.0, 39.0] |            -6.0 |
| rows   | BA    |   -42.0 [-51.0, -31.0] |   -32.0 [-42.0, -18.0] |           -10.0 |
| fcp    | AB    |         0.0 [0.0, 0.0] |         0.0 [0.0, 3.0] |             0.0 |
| fcp    | BA    |         0.0 [0.0, 0.0] |        0.0 [-3.0, 0.0] |             0.0 |
| pane   | AB    |      3.0 [-14.5, 18.2] |       12.8 [1.2, 22.7] |            -9.8 |
| pane   | BA    |   -39.2 [-52.9, -25.5] |   -32.8 [-47.3, -15.9] |            -6.5 |
| hello  | AB    |      26.4 [-1.7, 35.8] |      47.1 [24.7, 64.8] |           -20.7 |
| hello  | BA    |   -59.3 [-73.4, -50.5] |   -51.6 [-70.5, -32.0] |            -7.7 |
| loaf   | AB    |    -13.9 [-16.2, -5.5] |      -5.5 [-9.4, 22.9] |            -8.4 |
| loaf   | BA    |   -41.9 [-50.2, -35.7] |   -40.4 [-46.8, -25.8] |            -1.5 |

## native-reduced

| Metric | A/B pair deltas (AB, BA alternating)                | A/A pair deltas                                     |          Raw median | Better count | Order-balanced | A/A balanced | Adjusted tax |
| ------ | --------------------------------------------------- | --------------------------------------------------- | ------------------: | -----------: | -------------: | -----------: | -----------: |
| rows   | -20.0, -8.0, 24.0, -32.0, 12.0, -28.0, 4.0, -56.0   | -12.0, 0.0, 16.0, -40.0, 16.0, -72.0, 28.0, -48.0   |  -14.0 [-29.0, 6.0] |          5/8 |          -11.0 |        -14.0 |         -3.0 |
| fcp    | 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 8.0, 0.0              | -4.0, -8.0, 16.0, 0.0, 0.0, -12.0, 8.0, -12.0       |      0.0 [0.0, 0.0] |          0/8 |            0.0 |         -3.0 |         -3.0 |
| pane   | -19.2, -5.0, 33.6, -43.6, 24.1, -20.7, 10.1, -42.7  | -13.4, 13.4, -9.4, -30.5, 10.0, -65.5, 37.0, -35.8  | -12.1 [-26.2, 13.6] |          5/8 |           -7.3 |        -16.4 |         -9.1 |
| hello  | -21.9, -29.4, 47.5, -43.5, 47.1, -43.9, 38.6, -97.2 | -16.7, -16.6, 33.3, -48.0, 57.7, -85.2, 48.4, -88.6 | -25.7 [-43.6, 40.7] |          5/8 |           -0.4 |        -12.9 |        -12.5 |
| loaf   | -0.7, -13.1, 2.4, -6.7, 9.3, -15.2, 29.1, -66.5     | 19.0, -9.0, 0.4, -54.3, 20.1, -60.9, 19.1, -43.9    |   -3.7 [-13.6, 4.1] |          5/8 |           -4.2 |        -15.0 |        -10.9 |

| Metric | Order | A/B delta median [IQR] | A/A delta median [IQR] | Adjusted effect |
| ------ | ----- | ---------------------: | ---------------------: | --------------: |
| rows   | AB    |       8.0 [-2.0, 15.0] |       16.0 [9.0, 19.0] |            -8.0 |
| rows   | BA    |   -30.0 [-38.0, -23.0] |   -44.0 [-54.0, -30.0] |            14.0 |
| fcp    | AB    |         0.0 [0.0, 2.0] |       4.0 [-1.0, 10.0] |            -4.0 |
| fcp    | BA    |         0.0 [0.0, 0.0] |    -10.0 [-12.0, -6.0] |            10.0 |
| pane   | AB    |       17.1 [2.8, 26.5] |      0.3 [-10.4, 16.8] |            16.8 |
| pane   | BA    |   -31.7 [-42.9, -16.8] |   -33.1 [-43.2, -19.5] |             1.4 |
| hello  | AB    |      42.8 [23.5, 47.2] |      40.9 [20.8, 50.7] |             2.0 |
| hello  | BA    |   -43.7 [-57.2, -40.0] |   -66.6 [-86.0, -40.1] |            22.9 |
| loaf   | AB    |        5.8 [1.6, 14.2] |      19.0 [14.3, 19.3] |           -13.2 |
| loaf   | BA    |   -14.1 [-28.0, -11.5] |   -49.1 [-56.0, -35.2] |            35.0 |

## native-visual

| Metric | A/B pair deltas (AB, BA alternating)                   | A/A pair deltas                                     |           Raw median | Better count | Order-balanced | A/A balanced | Adjusted tax |
| ------ | ------------------------------------------------------ | --------------------------------------------------- | -------------------: | -----------: | -------------: | -----------: | -----------: |
| rows   | 12.0, -48.0, 32.0, -56.0, -32.0, -16.0, -16.0, -108.0  | -20.0, 8.0, 44.0, -36.0, 20.0, -68.0, 16.0, -88.0   |  -24.0 [-50.0, -9.0] |          6/8 |          -27.0 |        -17.0 |         10.0 |
| fcp    | -12.0, -16.0, -16.0, -32.0, -12.0, -12.0, -32.0, -12.0 | 12.0, 0.0, 12.0, 0.0, 8.0, -12.0, -12.0, -4.0       | -14.0 [-20.0, -12.0] |          8/8 |          -14.0 |          4.0 |         18.0 |
| pane   | 31.0, -31.2, 35.1, -18.8, -28.2, -6.0, -4.2, -77.0     | -19.8, 17.5, 52.5, -47.9, 13.0, -67.7, -14.0, -66.0 |   -12.4 [-29.0, 4.6] |          6/8 |           -5.8 |        -28.7 |        -22.9 |
| hello  | 17.5, -60.0, 37.3, -89.8, -37.4, -33.5, -13.1, -157.7  | -5.5, -14.8, 63.7, -58.2, 54.1, -82.9, 31.5, -77.2  |  -35.5 [-67.4, -5.5] |          6/8 |          -36.3 |        -12.4 |         23.9 |
| loaf   | -59.6, -46.3, 25.4, -92.8, -58.5, -2.1, -37.3, -94.1   | 55.4, 7.8, 31.2, -33.6, 3.1, -53.5, 0.5, -50.0      | -52.4 [-67.9, -28.5] |          7/8 |          -58.7 |        -12.3 |         46.4 |

| Metric | Order | A/B delta median [IQR] | A/A delta median [IQR] | Adjusted effect |
| ------ | ----- | ---------------------: | ---------------------: | --------------: |
| rows   | AB    |     -2.0 [-20.0, 17.0] |       18.0 [7.0, 26.0] |           -20.0 |
| rows   | BA    |   -52.0 [-69.0, -40.0] |   -52.0 [-73.0, -25.0] |             0.0 |
| fcp    | AB    |   -14.0 [-20.0, -12.0] |       10.0 [3.0, 12.0] |           -24.0 |
| fcp    | BA    |   -14.0 [-20.0, -12.0] |       -2.0 [-6.0, 0.0] |           -12.0 |
| pane   | AB    |     13.4 [-10.2, 32.0] |     -0.5 [-15.5, 22.9] |            13.9 |
| pane   | BA    |   -25.0 [-42.7, -15.6] |   -56.9 [-66.4, -31.5] |            31.9 |
| hello  | AB    |      2.2 [-19.2, 22.4] |      42.8 [22.2, 56.5] |           -40.6 |
| hello  | BA    |  -74.9 [-106.8, -53.4] |   -67.7 [-78.6, -47.3] |            -7.2 |
| loaf   | AB    |   -47.9 [-58.8, -21.6] |       17.2 [2.5, 37.3] |           -65.1 |
| loaf   | BA    |   -69.6 [-93.1, -35.2] |   -41.8 [-50.9, -23.3] |           -27.7 |
