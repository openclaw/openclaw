## Unreleased

### Fixes

- Google via ClawRouter: preserve terminal stream errors and intermediate checkpoints, issuing continuation replay receipts only after a valid final continuation and HTTP EOF. (#192147)
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
