---
type: project-memory
project: MAIAX
tags: [manufacturing, smart-factory, 7KL, fermentation, poc]
related:
  - "[[maioss|MAIOSS - OSS 보안]]"
  - "[[tech-intelligence|기술 인텔리전스]]"
---

# MAIAX — 강원대평 AX 실증단 7KL 발효 POC

## 개요

- **프로젝트명**: MAIAX (Smart Manufacturing AX)
- **목적**: 7KL 발효 공정의 Digital Twin 기반 이상 감지, 최적 제어, RAG 챗봇 지원 시스템 구축
- **기술 스택**: React + TypeScript (Frontend), FastAPI + Python (Backend), AI (PPO, LSTM, RAG)
- **시작일**: 2025-11 (추정, tasks.md 기준)

## 환경

- **로컬**: `C:\TEST\MAIAX`
- **GitHub**: https://github.com/jini92/MAIAX
- **Obsidian**: `01.PROJECT/03.MAIAX`
- **개발 도구**: MAIBOT 직접

## 주요 기능

- 실시간 모니터링: 16개 Tag Point (10초 주기)
- Digital Twin: pH, 온도, DO 시뮬레이션 + What-if 분석
- 이상 감지: AI 기반 (L1 경고, L2 이상)
- RAG 챗봇: SOP 설명, 이상 원인 분석, 권고 조치
- Retrofit Recipe: 성공 배치 기반 레시피 관리

## 진행 상황

- Phase 1 (프로젝트 정의): ✅ 완료
- Phase 2 (서브에이전트 설계): ✅ 완료
- POC 백엔드 API + 프론트엔드: 구현됨 (git log 확인)
- Phase 3+ (본격 개발): 진행 중

## 결정사항

- pH 3-Track: pH_max/mid/min 시스템
- DB: InfluxDB(시계열) + PostgreSQL(운영) + MongoDB(메타) + ChromaDB(벡터)
- 모의 데이터 우선 개발 (PLC 연동 전)

---

_Last updated: 2026-02-19_
