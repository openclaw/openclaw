# Routing Groups Coverage Report

Generated from:

- `/Users/rdy/Documents/openclaw/routing-groups.v1.json`
- `/Users/rdy/Documents/openclaw/cards.metadata.merged64.json`

## Summary

- Single-choice combinations evaluated: **6144**
- Group matched in exact mode: **3072**
- Group matched in partial mode: **3072**
- Returns with fewer than 3 cards: **0**
- Card witness self-hit in top-3: **61/64**

## Group Catch Distribution (single-choice grid)

| Group                                | Combos Caught |  Share |
| ------------------------------------ | ------------: | -----: |
| G01_discovery_unknown_no_authority   |          2784 | 45.31% |
| G02_discovery_stable_team            |          1248 | 20.31% |
| G10_community_public_policy          |          1056 | 17.19% |
| G15_learning_method_individual       |           576 |  9.38% |
| G07_governance_decide_later          |           288 |  4.69% |
| G08_ethics_incident_unknown          |            96 |  1.56% |
| G05_transition_reintegration_fragile |            96 |  1.56% |

## Fallback Invocation Counts

Fallback level meaning:

- `0` strict recipe
- `1` relax `pace`
- `2` relax `pace + interaction`
- `3` relax `pace + interaction + stance`
- `4` global backfill

| Fallback Level | Slot Selections |
| -------------: | --------------: |
|              0 |           18432 |

## Witness Routing Check (64 cards)

| Card    | Routed Group                         | Card in Top-3 | Group Mode |
| ------- | ------------------------------------ | ------------- | ---------- |
| card_01 | G15_learning_method_individual       | yes           | exact      |
| card_02 | G04_care_uneven_collective           | yes           | exact      |
| card_03 | G03_care_fragile_private             | yes           | exact      |
| card_04 | G06_governance_advisory_exec         | yes           | exact      |
| card_05 | G04_care_uneven_collective           | yes           | exact      |
| card_06 | G06_governance_advisory_exec         | yes           | exact      |
| card_07 | G06_governance_advisory_exec         | yes           | exact      |
| card_08 | G06_governance_advisory_exec         | yes           | exact      |
| card_09 | G06_governance_advisory_exec         | yes           | exact      |
| card_10 | G10_community_public_policy          | yes           | exact      |
| card_11 | G10_community_public_policy          | yes           | exact      |
| card_12 | G06_governance_advisory_exec         | yes           | exact      |
| card_13 | G06_governance_advisory_exec         | yes           | exact      |
| card_14 | G10_community_public_policy          | yes           | exact      |
| card_15 | G10_community_public_policy          | yes           | exact      |
| card_16 | G10_community_public_policy          | yes           | exact      |
| card_17 | G04_care_uneven_collective           | yes           | exact      |
| card_18 | G03_care_fragile_private             | yes           | exact      |
| card_19 | G05_transition_reintegration_fragile | yes           | exact      |
| card_20 | G06_governance_advisory_exec         | yes           | exact      |
| card_21 | G04_care_uneven_collective           | yes           | exact      |
| card_22 | G04_care_uneven_collective           | yes           | exact      |
| card_23 | G06_governance_advisory_exec         | yes           | exact      |
| card_24 | G06_governance_advisory_exec         | yes           | exact      |
| card_25 | G03_care_fragile_private             | yes           | exact      |
| card_26 | G06_governance_advisory_exec         | yes           | exact      |
| card_27 | G05_transition_reintegration_fragile | yes           | exact      |
| card_28 | G05_transition_reintegration_fragile | yes           | exact      |
| card_29 | G06_governance_advisory_exec         | yes           | exact      |
| card_30 | G01_discovery_unknown_no_authority   | yes           | exact      |
| card_31 | G07_governance_decide_later          | yes           | exact      |
| card_32 | G06_governance_advisory_exec         | yes           | exact      |
| card_33 | G07_governance_decide_later          | yes           | exact      |
| card_34 | G03_care_fragile_private             | yes           | exact      |
| card_35 | G04_care_uneven_collective           | yes           | exact      |
| card_36 | G06_governance_advisory_exec         | no            | exact      |
| card_37 | G06_governance_advisory_exec         | yes           | exact      |
| card_38 | G06_governance_advisory_exec         | yes           | exact      |
| card_39 | G07_governance_decide_later          | yes           | exact      |
| card_40 | G10_community_public_policy          | yes           | exact      |
| card_41 | G10_community_public_policy          | yes           | exact      |
| card_42 | G06_governance_advisory_exec         | yes           | exact      |
| card_43 | G06_governance_advisory_exec         | yes           | exact      |
| card_44 | G06_governance_advisory_exec         | yes           | exact      |
| card_45 | G03_care_fragile_private             | yes           | exact      |
| card_46 | G10_community_public_policy          | yes           | exact      |
| card_47 | G10_community_public_policy          | yes           | exact      |
| card_48 | G06_governance_advisory_exec         | yes           | exact      |
| card_49 | G01_discovery_unknown_no_authority   | yes           | partial    |
| card_50 | G10_community_public_policy          | yes           | exact      |
| card_51 | G07_governance_decide_later          | yes           | exact      |
| card_52 | G08_ethics_incident_unknown          | yes           | exact      |
| card_53 | G07_governance_decide_later          | yes           | exact      |
| card_54 | G05_transition_reintegration_fragile | yes           | exact      |
| card_55 | G01_discovery_unknown_no_authority   | yes           | exact      |
| card_56 | G07_governance_decide_later          | yes           | exact      |
| card_57 | G01_discovery_unknown_no_authority   | yes           | exact      |
| card_58 | G02_discovery_stable_team            | yes           | exact      |
| card_59 | G05_transition_reintegration_fragile | yes           | partial    |
| card_60 | G01_discovery_unknown_no_authority   | yes           | exact      |
| card_61 | G02_discovery_stable_team            | yes           | exact      |
| card_62 | G03_care_fragile_private             | no            | exact      |
| card_63 | G08_ethics_incident_unknown          | yes           | exact      |
| card_64 | G02_discovery_stable_team            | no            | exact      |

## Notes

- This report uses a baseline multi-select profile for the single-choice grid:
  - `urgency=[lived_experience]`
  - `population=[specific_stakeholder]`
  - `interaction=[async_over_time]`
  - `outcomes=[partial_clarity, unresolved_tension]`
  - `boundaries=[attribution_to_individuals]`
- Use real wizard traffic replay to refine group thresholds and memory boosts.
