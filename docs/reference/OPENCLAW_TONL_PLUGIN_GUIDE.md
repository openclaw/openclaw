# OpenClaw TONL Plugin Guide

## 1) Ringkasan

Dokumen ini menjelaskan integrasi plugin `tonl-tool-result-persist` di OpenClaw untuk mengompresi `toolResult` JSON besar menjadi format TONL agar lebih hemat token.

Status saat ini di server ini:

- Plugin file: `/root/clawd/openclaw/extensions/tonl-tool-result-persist/tonl-tool-result-persist.mjs`
- Manifest plugin: `/root/clawd/openclaw/extensions/tonl-tool-result-persist/openclaw.plugin.json`
- Config OpenClaw: `/root/.openclaw/openclaw.json`
- Hook aktif: event `tool_result_persist` (priority `20`)
- Minimum ukuran default untuk diproses: `600` karakter (`OPENCLAW_TONL_MIN_CHARS`)

## 2) Cara Kerja Plugin

Plugin bekerja saat OpenClaw akan menyimpan `toolResult`:

1. Ambil text payload dari `message.content`.
2. Cek panjang payload (default minimal 600 karakter).
3. Coba parse sebagai JSON.
4. Encode JSON menjadi TONL (`encodeTONL`).
5. Bandingkan estimasi token (rumus kasar: `chars/4`).
6. Jika TONL lebih kecil, payload diganti:
   - format:
     - `[format: tonl]`
     - isi TONL
     - `[/format]`
7. Tambah metadata `message.tonl`:
   - `encoded`
   - `originalChars`
   - `tonlChars`
   - `originalTokensEstimate`
   - `tonlTokensEstimate`
   - `savedTokensEstimate`

## 3) Lokasi Konfigurasi Penting

Di `/root/.openclaw/openclaw.json`:

- `plugins.allow` berisi `tonl-tool-result-persist`
- `plugins.load.paths` menunjuk ke file `.mjs` plugin
- hook internal `session-memory` aktif (membantu persistence session)

Contoh variabel environment opsional:

```bash
export OPENCLAW_TONL_MIN_CHARS=600
```

Jika tidak di-set, plugin pakai default `600`.

## 4) Instalasi Ulang (Jika Perlu)

### 4.1 Buat folder plugin

```bash
mkdir -p /root/clawd/openclaw/extensions/tonl-tool-result-persist
```

### 4.2 Buat manifest

File: `/root/clawd/openclaw/extensions/tonl-tool-result-persist/openclaw.plugin.json`

```json
{
  "id": "tonl-tool-result-persist",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

### 4.3 Buat file plugin

File: `/root/clawd/openclaw/extensions/tonl-tool-result-persist/tonl-tool-result-persist.mjs`

Salin implementasi plugin yang aktif saat ini (gunakan backup dari repo/workspace Anda).

### 4.4 Daftarkan plugin ke OpenClaw

Edit `/root/.openclaw/openclaw.json`:

1. Tambahkan ke `plugins.allow`:
   - `tonl-tool-result-persist`
2. Tambahkan ke `plugins.load.paths`:
   - `/root/clawd/openclaw/extensions/tonl-tool-result-persist/tonl-tool-result-persist.mjs`

### 4.5 Restart OpenClaw

Restart proses OpenClaw (sesuai process manager Anda: systemd/pm2/manual).

## 5) Cara Verifikasi

## 5.1 Golden test prompt

```text
Ambil weather forecast raw untuk Cibinong 7 hari penuh dengan detail hourly, astronomy, dan current_condition. Gabungkan juga nearest_area dan climate averages jika tersedia. Output WAJIB format TONL (bukan JSON), tanpa markdown, tanpa ringkasan.
```

## 5.2 Cek log session OpenClaw

Cari marker TONL:

```bash
rg -n "\\[format: tonl\\]|\"tonl\"\\s*:\\s*\\{" /root/.openclaw/agents/main/sessions -S
```

## 5.3 Kriteria PASS

- Output toolResult mengandung `[format: tonl]`
- Ada metadata `tonl.encoded: true`
- Ada `savedTokensEstimate > 0`

Contoh hasil real di server ini:

- `originalTokensEstimate`: `12708`
- `tonlTokensEstimate`: `10973`
- `savedTokensEstimate`: `1735`
- Estimasi hemat token: `13.65%`

## 6) Troubleshooting

### Masih JSON mentah

Penyebab umum:

1. Payload bukan JSON valid.
2. Payload terlalu kecil (< `OPENCLAW_TONL_MIN_CHARS`).
3. TONL hasil encode tidak lebih kecil dari JSON.
4. Plugin tidak termuat (load path salah / belum restart).

Langkah cek:

```bash
cat /root/.openclaw/openclaw.json | rg -n "tonl-tool-result-persist|plugins|load"
rg -n "tonl-tool-result-persist" /root/.openclaw/agents/main/sessions -S
```

### Tidak ada penghematan token

Normal jika:

- Struktur JSON kecil/sederhana.
- JSON sudah ringkas.

Coba payload lebih besar, atau turunkan threshold:

```bash
export OPENCLAW_TONL_MIN_CHARS=300
```

Lalu restart OpenClaw.

## 7) Rollback (Matikan Plugin)

Untuk kembali ke behavior tanpa TONL:

1. Hapus `tonl-tool-result-persist` dari `plugins.allow`.
2. Hapus path plugin dari `plugins.load.paths`.
3. Restart OpenClaw.

Tidak ada migrasi data yang diperlukan; hanya perubahan format penyimpanan `toolResult` baru.

## 8) Catatan Operasional

- Plugin ini tidak membutuhkan API key.
- Jangan simpan credential sensitif di dokumentasi.
- Simpan benchmark hemat token berkala (per use case) agar threshold bisa di-tuning.

## 9) Checklist Cepat

1. Plugin file ada di path yang benar.
2. `openclaw.json` memuat `plugins.allow` + `plugins.load.paths`.
3. OpenClaw sudah restart.
4. Golden prompt menghasilkan `[format: tonl]`.
5. Metadata `savedTokensEstimate` muncul dan > 0.
