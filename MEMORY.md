# MEMORY.md — 프로젝트 인덱스

_마이봇과 지니의 프로젝트 총 목록. 새 프로젝트 시작 시 여기에 추가._

## 활성 프로젝트

| #   | 프로젝트                             | 파일                                                 | 상태      | 시작일     |
| --- | ------------------------------------ | ---------------------------------------------------- | --------- | ---------- |
| 1   | 베트남 호치민 화장품 사업 (BnF)      | [memory/vietnam-beauty.md](memory/vietnam-beauty.md) | 🟢 진행중 | 2026-01-30 |
| 2   | MAIOSS (AI OSS 보안 스캐너)          | [memory/maioss.md](memory/maioss.md)                 | 🟢 진행중 | 2025-08    |
| 3   | MAISTAR7 (베트남 한국기업 인력 매칭) | [memory/maistar7.md](memory/maistar7.md)             | 🟢 진행중 | 2026-02-11 |
| 4   | MAICON (AI 베트남 로컬 서비스 예약)  | [memory/maicon.md](memory/maicon.md)                 | 🟢 진행중 | 2026-02-13 |
| 5   | MAITUTOR                             | [memory/maitutor.md](memory/maitutor.md)             | 🟢 진행중 | 2026-02-14 |
| 6   | MAIBOTALKS (마이봇 음성대화 앱)      | [memory/maibotalks.md](memory/maibotalks.md)         | 🟢 진행중 | 2026-02-15 |
| 7   | MAITOK (Tikly - TikTok 댓글 AI)      | [memory/maitok.md](memory/maitok.md)                 | 🟢 진행중 | 2026-02-18 |
| 8   | MAIAX (스마트제조 AX 7KL 발효 POC)   | [memory/maiax.md](memory/maiax.md)                   | 🟢 진행중 | 2025-11    |

### 개발 환경 요약

| 프로젝트        | 로컬 경로            | GitHub                                                    | 개발 도구   | 배포                   |
| --------------- | -------------------- | --------------------------------------------------------- | ----------- | ---------------------- |
| MAIBEAUTY (BnF) | `C:\TEST\MAIBEAUTY`  | [jini92/MAIBEAUTY](https://github.com/jini92/MAIBEAUTY)   | MAIBOT 직접 | —                      |
| MAIOSS          | `C:\TEST\MAIOSS`     | [jini92/MAIOSS](https://github.com/jini92/MAIOSS)         | MAIBOT 직접 | Railway + GitHub Pages |
| MAISTAR7        | `C:\TEST\MAISTAR7`   | TBD                                                       | MAIBOT 직접 | TBD                    |
| MAICON          | `C:\TEST\MAICON`     | TBD                                                       | MAIBOT 직접 | TBD                    |
| MAITUTOR        | `C:\TEST\MAITUTOR`   | [jini92/MAITUTOR](https://github.com/jini92/MAITUTOR)     | MAIBOT 직접 | TBD                    |
| MAIBOTALKS      | `C:\TEST\MAIBOTALKS` | [jini92/MAIBOTALKS](https://github.com/jini92/MAIBOTALKS) | MAIBOT 직접 | TBD                    |
| MAITOK (Tikly)  | `C:\TEST\MAITOK`     | [jini92/MAITOK](https://github.com/jini92/MAITOK)         | MAIBOT 직접 | TBD                    |
| MAIAX           | `C:\TEST\MAIAX`      | [jini92/MAIAX](https://github.com/jini92/MAIAX)           | MAIBOT 직접 | TBD                    |
| MAIBOT (메인)   | `C:\MAIBOT`          | [jini92/MAIBOT](https://github.com/jini92/MAIBOT)         | MAIBOT 직접 | —                      |

## 개발 방식 (전체 프로젝트 공통)

| 항목      | 내용                                                                |
| --------- | ------------------------------------------------------------------- |
| 방식      | 🔧 **MAIBOT 직접 구현** — 코드 읽기/쓰기/편집 + git 커밋/푸시       |
| 변경일    | 2026-02-07                                                          |
| 이전 방식 | ~~하이브리드 (MAIBOT + Claude Code CLI)~~ — MCP/plugins 충돌로 폐기 |
| 적용 범위 | 모든 프로젝트 (MAIBEAUTY, MAIOSS, MAIBOT 등)                        |
| 장점      | 안정적, 충돌 없음, 컨텍스트 일관성, 즉시 실행                       |

## 완료 프로젝트

_(아직 없음)_

## 보류 프로젝트

_(아직 없음)_

---

## 관리 규칙

- 새 프로젝트 → `memory/프로젝트명.md` 생성 + 이 파일에 등록
- 상태: 🟢 진행중 / 🟡 보류 / 🔴 중단 / ✅ 완료
- 프로젝트 종료 시 → 완료 섹션으로 이동
- 각 프로젝트 파일에 목표, 진행상황, 결정사항, 다음 액션 기록

---

_Last updated: 2026-02-19_
