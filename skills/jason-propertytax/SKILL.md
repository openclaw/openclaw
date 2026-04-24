---
name: propertytax
description: Use when Jason asks to look up California property tax rate, APN/AIN, tax bill PDF, Mello-Roos/direct assessments, or automate address to county assessor to tax collector bill flows. Prioritize OC, LA, San Bernardino, and Riverside county paths already proven in Jason's workflow.
---

# PropertyTax

Use this skill when Jason gives a property address and wants the actual property tax rate from the county tax bill, plus the bill PDF when available.

## Output Contract

For each address, return:

- `county`
- `address_normalized`
- `apn` or `ain`
- `tax_year`
- `tax_rate`: the sum of ad valorem `RATE` lines printed on the bill, as a percent number such as `1.176631`
- `direct_assessments_total`: fixed charges/direct assessments total, separate from `tax_rate`
- `total_tax_bill`
- `bill_pdf_url` when available
- local saved PDF path when downloaded
- short source path used, especially if a manual confirmation step remains

Do not fold fixed direct assessments into `tax_rate`. If an all-in effective rate is useful, label it separately as `all_in_effective_rate`, never as the official tax rate.

## Standard Workflow

1. Resolve county from the address.
2. Resolve address to APN/AIN through the assessor or parcel source.
3. Resolve APN/AIN to current secured tax bill.
4. Download the current bill PDF when the county exposes one.
5. Extract the bill text with `pdftotext -layout`.
6. Read the printed `RATE` column and sum only ad valorem lines.
7. Sum fixed `DIRECT ASSESSMENTS`, special assessments, CFD/Mello-Roos, sewer, vector, library, fire, water standby, and similar amount-only lines separately.
8. If the bill is blocked by captcha or manual UI, return the confirmed APN/AIN and exact bill lookup URL, and clearly mark `tax_rate` as unconfirmed.

Preferred local output directory for downloaded bills:

```bash
/Users/jason/Documents/Project/MLO/output/property_tax_bills/
```

## County Paths

### Orange County

Address/APN:

- Use OC Assessor/property search if needed.
- Tax bill PDF pattern that has worked:

```text
http://oct.estreamone.com/Show.aspx?parcel={apn_without_dashes_or_as_accepted}&year={roll_year}
```

Known regression:

- `188 Fixie, Irvine, CA 92618`
- APN `930-171-30`
- TRA `26-248`
- 2025 rate `1.05450`
- Saved bill: `/Users/jason/Documents/Project/MLO/output/property_tax_bills/orange_county_93017130_2025_property_tax_bill.pdf`

### Los Angeles County

Address to AIN:

```text
https://portal.assessor.lacounty.gov/api/search?search={url_encoded_address}
```

AIN detail / TRA:

```text
https://portal.assessor.lacounty.gov/api/parceldetail?ain={10_digit_ain}
```

AIN to bill links:

```bash
curl -sS -L -X POST 'https://ttc.lacounty.gov/secured-property-tax-results' \
  --data 'ain={10_digit_ain}&timestamp='$(date +%s)
```

The returned HTML can contain year-specific `https://latapi.estreamone.com/repos/LAT2-Main/docs/...` PDF links. Download the newest annual secured bill and parse the `RATE` column.

Known regression:

- `2362 Agostino Dr, Rowland Heights, CA 91748`
- AIN `8265027010`, display `8265-027-010`
- TRA `12005`
- 2025-26 bill rate `1.176631`
- Rate lines: `1.000000 + 0.007000 + 0.058548 + 0.111083`
- Direct assessments total `$1,158.01`
- Total bill `$14,197.90`
- Saved bill: `/Users/jason/Documents/Project/MLO/output/property_tax_bills/la_county_8265027010_2025_annual_secured_bill.pdf`

### San Bernardino County

Address to APN:

Use public ArcGIS parcel layer:

```text
https://services.arcgis.com/aA3snZwJfFkVyDuP/arcgis/rest/services/Internal_SB_County_Parcels_ForPublicView/FeatureServer/0
```

Current bill/tax detail CSV sources:

```text
https://county-reports.com/ca-sanbernardino/Curr-Roll-Yr-Annual-Bills-Assessments-Bills.csv
https://county-reports.com/ca-sanbernardino/Curr-Year-District-Tax-Detail-Bill-Tax-Detail.csv
```

TaxSys payables API for bill path:

```bash
curl -sS 'https://gsgprod.sbcountyatc.gov/svc/payables/v0/Taxsys-GovHub/v0' \
  -H 'content-type: application/json' \
  --data '{"query":{"querystring":"{account_or_apn}"},"options":{"county":"sanbernardino-ca","module":"property_tax"}}'
```

Use the returned parent/item paths to build the direct PDF URL. Prefer the direct host over the iframe host:

```text
https://sanbernardino-ca.county-taxes.com/govhub/property-tax/{base64_parent_token}/bills/{bill_uuid}/print
```

Avoid relying on `county-taxes.net/iframe-taxsys/...` for automation; it can hit Cloudflare/403. Jason already proved the iframe shape manually, but the direct host is the automation path.

Known regressions:

- `2874 S Whispering Lakes Ln, Ontario, CA 91761`
- APN `011350511`, account `0113505110000`
- TRA `004-016`
- 2025 rate `1.10936608`
- Direct charges `$29.75`

- `1465 E St Andrews St, Ontario, CA 91761`
- APN `021645172`, account `0216451720000`
- TRA `004-027`
- 2025 rate `1.10936608`
- Direct charges `$71.04`
- Saved bill: `/Users/jason/Documents/Project/MLO/output/property_tax_bills/san_bernardino_county_0216451720000_2025_secured_bill.pdf`

### Riverside County

Account summary and bill detail paths use `ca-riverside-ttc.publicaccessnow.com`.

Known regression:

- `6128 El Prado Ave, Eastvale, CA 92880`
- APN/PIN `164730016`
- 2025 rate `1.12467`
- Fixed CFD/Mello-Roos-like charges total `$3,118.92`
- PDF URL pattern:

```text
https://ca-riverside-ttc.publicaccessnow.com/AccountSearch/AccountSummary/PrintTaxBill.aspx?p={pin}&y={year}&b={bill_id}&clearcache=true
```

- Saved bill: `/Users/jason/Documents/Project/MLO/output/property_tax_bills/riverside_county_164730016_2025_property_tax_bill.pdf`

## Rate Parsing Rules

Treat these as ad valorem rate lines when they have a printed percentage/rate:

- general tax levy / all agencies
- voted indebtedness
- school/college bond rates
- water district rate lines
- any line with a `RATE` value and calculated amount

Treat these as fixed/direct assessment lines when they are amount-only:

- direct assessments
- special assessments
- CFD / Mello-Roos / debt service when no rate is printed
- sewer, vector, library, fire, water standby, flood control, solid waste, lighting, parkway maintenance

Jason's expected `tax_rate` is the bill's printed rate sum. For example, LA County `1.000000 + .007000 + .058548 + .111083 = 1.176631`; return `tax_rate = 1.176631`.

## Failure Handling

If automation cannot download a bill:

- do not say no PDF exists until the county's bill path has been checked
- return the public bill lookup URL and the exact blocker, such as captcha, Cloudflare, missing current-year bill, or manual account selection
- keep APN/AIN, TRA, assessed value, and county source separate from the unconfirmed bill fields

If there is ambiguity between multiple parcels:

- prefer exact situs address match
- show the candidate APN/AIN and situs
- ask Jason only if there are multiple exact or near-exact matches with material risk
