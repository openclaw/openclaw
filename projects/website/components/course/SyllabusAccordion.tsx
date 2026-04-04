'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface Day {
  title: string
  content: string[]
  tip?: string
}

interface SyllabusAccordionProps {
  syllabus: string
}

// 每天的核心技巧提示
const dayTips: Record<number, string> = {
  0: '用 ChatGPT 的 Custom Instructions 建立個人風格，只要設定一次，之後每次對話都帶著你的語氣。課程中會教你如何用手機設定，回家立刻能用！',
  1: 'ManyChat 自動私訊的秘訣：設計「留言觸發詞」，例如有人留言「+1」就自動私訊優惠資訊。一次設定，24/7 自動轉換！',
  2: '你的 AI 工具包會包含「Prompt 組合器」，輸入幾個關鍵字，自動組合成完整 prompt。就像填空題一樣簡單，不用每次重新想怎麼下指令！'
}

export default function SyllabusAccordion({ syllabus }: SyllabusAccordionProps) {
  const [openDay, setOpenDay] = useState<number | null>(null)

  // Parse syllabus into days
  const parseDays = (text: string): Day[] => {
    const days: Day[] = []
    const lines = text.split('\n').filter(line => line.trim())

    let currentDay: Day | null = null

    lines.forEach(line => {
      const trimmed = line.trim()

      // Detect day headers (📅 第X天：...)
      if (trimmed.match(/^📅\s*第[一二三]天：/)) {
        if (currentDay) {
          days.push(currentDay)
        }
        currentDay = {
          title: trimmed,
          content: [],
          tip: dayTips[days.length] // 根據索引添加提示
        }
      } else if (currentDay) {
        currentDay.content.push(trimmed)
      }
    })

    if (currentDay) {
      days.push(currentDay)
    }

    return days
  }

  const days = parseDays(syllabus)

  const toggleDay = (index: number) => {
    const newOpenDay = openDay === index ? null : index
    setOpenDay(newOpenDay)

    // 觸發進度追蹤（當展開時）
    if (newOpenDay === index && typeof window !== 'undefined' && (window as any).trackDayOpened) {
      (window as any).trackDayOpened(index)
    }
  }

  const formatContent = (content: string[]) => {
    return content.map((line, index) => {
      // Time slot headers (09:30-11:00 | Course XX)
      if (line.match(/^\d{2}:\d{2}-\d{2}:\d{2}\s*\|/)) {
        return (
          <div key={index} className="text-base font-semibold mt-4 mb-2 text-orange-400">
            {line}
          </div>
        )
      }

      // List items (• or ✅)
      if (line.match(/^[•✅\-→]/)) {
        return (
          <div key={index} className="text-sm text-gray-300 mb-1.5 pl-6 flex gap-2">
            <span className="text-orange-400 shrink-0">•</span>
            <span>{line.replace(/^[•✅\-→]\s*/, '')}</span>
          </div>
        )
      }

      // Regular paragraphs
      return (
        <p key={index} className="text-sm text-gray-300 mb-2 leading-relaxed">
          {line}
        </p>
      )
    })
  }

  return (
    <div className="space-y-3">
      {days.map((day, index) => (
        <div
          key={index}
          className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden"
        >
          {/* Header - Always visible */}
          <button
            onClick={() => toggleDay(index)}
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-700/30 transition-colors"
          >
            <h3 className="text-lg font-bold text-white text-left">
              {day.title}
            </h3>
            <div className="flex-shrink-0 ml-4">
              {openDay === index ? (
                <ChevronUp className="w-5 h-5 text-orange-400" />
              ) : (
                <ChevronDown className="w-5 h-5 text-gray-400" />
              )}
            </div>
          </button>

          {/* Content - Collapsible */}
          <div
            className={`overflow-hidden transition-all duration-300 ${
              openDay === index ? 'max-h-[3000px]' : 'max-h-0'
            }`}
          >
            <div className="px-6 pb-6 pt-2">
              {formatContent(day.content)}

              {/* Core Tip */}
              {day.tip && (
                <div className="mt-6 pt-4 border-t border-gray-700">
                  <div className="bg-orange-500/10 rounded-lg p-4 border border-orange-400/20">
                    <div className="flex items-start gap-3">
                      <span className="text-xl shrink-0">💡</span>
                      <div>
                        <h5 className="text-sm font-bold text-orange-400 mb-2">
                          Day {index + 1} 核心技巧
                        </h5>
                        <p className="text-sm text-gray-300 leading-relaxed">
                          {day.tip}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
