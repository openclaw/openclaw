# OpenClaw TONL Runbook (Quick Ops)

## Tujuan

Panduan cepat untuk memastikan kompresi TONL aktif dan menangani masalah umum.

## Lokasi Penting

- Config: `/root/.openclaw/openclaw.json`
- Plugin: `/root/clawd/openclaw/extensions/tonl-tool-result-persist/tonl-tool-result-persist.mjs`
- Session logs: `/root/.openclaw/agents/main/sessions/`
- Guide lengkap: `/root/clawd/OPENCLAW_TONL_PLUGIN_GUIDE.md`

## Daily Check (2 menit)

1. Validasi plugin terdaftar:

```bash
rg -n "tonl-tool-result-persist|plugins.load.paths|plugins.allow" /root/.openclaw/openclaw.json -S
```

2. Cek hasil TONL terbaru:

```bash
rg -n "\[format: tonl\]|\"tonl\"\s*:\s*\{" /root/.openclaw/agents/main/sessions -S | tail -n 10
```

3. Cek penghematan token:

```bash
rg -n "\"savedTokensEstimate\"" /root/.openclaw/agents/main/sessions -S | tail -n 10
```

## Golden Test

Kirim prompt ini ke OpenClaw:

```text
Ambil weather forecast raw untuk Cibinong 7 hari penuh dengan detail hourly, astronomy, dan current_condition. Gabungkan juga nearest_area dan climate averages jika tersedia. Output WAJIB format TONL (bukan JSON), tanpa markdown, tanpa ringkasan.
```

PASS jika:

1. Ada `[format: tonl]`
2. Ada `tonl.encoded: true`
3. Ada `savedTokensEstimate > 0`

## Jika Output Masih JSON Mentah

1. Cek threshold env:

```bash
echo "$OPENCLAW_TONL_MIN_CHARS"
```

2. Untuk uji cepat, turunkan threshold:

```bash
export OPENCLAW_TONL_MIN_CHARS=300
```

3. Restart OpenClaw (sesuai process manager Anda).
4. Ulangi golden test.

## Rollback Cepat

1. Hapus `tonl-tool-result-persist` dari:
   - `plugins.allow`
   - `plugins.load.paths`
2. Restart OpenClaw.
3. Verifikasi tidak ada marker TONL baru di session.

## KPI Operasional

- Target hemat token: `>= 10%` untuk payload JSON besar
- Alert jika:
  - 24 jam tidak ada event TONL padahal ada toolResult JSON besar
  - `savedTokensEstimate <= 0` berulang pada kasus serupa
