# MAIPID Project — Current Guard Tests

File: `C:\TEST\MAIPID\tests\test_pipeline_regression.py` (9 tests)

| Test                                     | Protected Setting      | Evidence                  |
| ---------------------------------------- | ---------------------- | ------------------------- |
| `test_batch_mode_is_single_not_grid`     | `batch_mode="single"`  | grid 2x2: -18% ISA recall |
| `test_no_confidence_floor`               | confidence filter 없음 | floor=0.5: -16% recall    |
| `test_cache_key_includes_detection_mode` | cache key 포함         | 없으면 0 ISA tags 반환    |
| `test_hough_param2_default`              | `param2=0.50`          | Sprint9 최적값            |
| `test_isa_tag_pattern_*`                 | digit range `{2,6}`    | 2자리 루프 필요           |
| `test_hough_min/max_radius`              | min=10, max=55         | 노이즈/병합 방지          |

Run: `pytest tests/test_pipeline_regression.py -v`
