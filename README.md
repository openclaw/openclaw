# ☕ Thinker Cafe — 思考者咖啡官網

[![Deploy](https://img.shields.io/badge/deploy-Vercel-black?logo=vercel)](https://vercel.com)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org)

> 一個內容驅動的現代咖啡品牌網站。產品、團隊介紹、品牌故事全部來自 **Notion**，開發者只需專注程式碼。

**🌐 Production**: [https://www.thinker.cafe](https://www.thinker.cafe)

---

## ✨ Features

- 🎨 **Notion CMS** — 產品、團隊、品牌內容全由 Notion 管理，非技術人員也能更新
- ⚡ **ISR 增量渲染** — 內容更新自動重新生成，兼顧效能與即時性
- 📱 **響應式設計** — 手機、平板、桌面完美適配
- 🎭 **動態動畫** — CSS + IntersectionObserver 打造流暢視覺體驗

---

## 🛠 Tech Stack

| 類別 | 技術 |
|------|------|
| **Framework** | Next.js 15 (App Router, Server Components) |
| **Language** | TypeScript |
| **UI** | React 19, Tailwind CSS, shadcn/ui |
| **Icons** | Lucide React |
| **Data** | Notion API |
| **Package Manager** | pnpm |
| **Deploy** | Vercel |

---

## 🚀 Getting Started

```bash
# 1. Clone & Install
git clone https://github.com/ThinkerCafe-tw/thinker_official_website.git
cd thinker_official_website
pnpm install

# 2. 設定環境變數
cp .env.example .env.local
# 填入 Notion API Key（找 Rhaenyra 或 Cruz 拿）

# 3. 啟動開發伺服器
pnpm dev
# → http://localhost:3000
```

---

## 📁 Project Structure

```
├── app/                  # Next.js App Router 頁面
│   ├── page.tsx          # 首頁
│   ├── about/            # 關於我們
│   ├── products/         # 產品頁
│   └── layout.tsx        # 全站 Layout
├── components/           # React 組件
│   ├── ui/               # shadcn/ui 基礎組件
│   └── sections/         # 頁面區塊組件
├── lib/                  # 工具函數
│   └── notion.ts         # Notion API 封裝
├── public/               # 靜態資源
└── styles/               # 全域樣式
```

---

## 👥 Team

| 角色 | 成員 |
|------|------|
| **Founder** | Cruz Tang |
| **Co-founder** | Rhaenyra, Vivian |
| **Dev** | Contributors |

---

## 🤝 Contributing

1. Fork this repo
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit (`git commit -m 'Add amazing feature'`)
4. Push (`git push origin feature/amazing`)
5. Open Pull Request

---

## 📄 License

MIT © ThinkerCafe

---

<p align="center">
  <sub>Built with ☕ and 💙 by ThinkerCafe team</sub>
</p>
