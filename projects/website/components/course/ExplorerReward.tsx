'use client'

import { useState, useEffect } from 'react'
import { Gift } from 'lucide-react'

interface ExplorerRewardProps {
  courseId: number
}

const DISCOUNT_AMOUNT = 500
const REWARD_STORAGE_KEY = 'explorer_discount'

export default function ExplorerReward({ courseId }: ExplorerRewardProps) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    // 檢查是否已解鎖（必須完成所有步驟）
    const storageKey = `course_${courseId}_progress`
    const checkUnlock = () => {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        try {
          const progress = JSON.parse(saved)
          // 必須完成所有步驟：選擇角色 + 3天課程（0,1,2） + 滾到底部
          const daysOpened = progress.daysOpened || []
          const uniqueDays = new Set(daysOpened)

          const allCompleted = progress.scrolledToBottom &&
                              progress.roleSelected &&
                              uniqueDays.size === 3

          if (allCompleted) {
            // 儲存折扣資格到 localStorage
            const rewardData = {
              amount: DISCOUNT_AMOUNT,
              courseId,
              unlockedAt: Date.now()
            }
            localStorage.setItem(REWARD_STORAGE_KEY, JSON.stringify(rewardData))
            setShow(true)
          }
        } catch (e) {
          console.error('Failed to parse progress:', e)
        }
      }
    }

    // 初始檢查
    checkUnlock()

    // 每秒檢查一次（監聽 localStorage 變化）
    const interval = setInterval(checkUnlock, 1000)
    return () => clearInterval(interval)
  }, [courseId])

  if (!show) return null

  return (
    <div className="my-8 animate-fade-in">
      <div className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 rounded-xl p-6 border-2 border-green-400/30 shadow-lg">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0">
            <div className="w-16 h-16 bg-gradient-to-br from-green-400 to-emerald-500 rounded-full flex items-center justify-center">
              <Gift className="w-8 h-8 text-white" />
            </div>
          </div>

          <div className="flex-1">
            <h3 className="text-2xl font-bold text-green-400 mb-2 flex items-center gap-2">
              <span>🎉</span>
              <span>恭喜解鎖！探索者專屬獎勵</span>
            </h3>

            <p className="text-gray-300 mb-4 leading-relaxed">
              你很認真地看完了整個課程介紹！作為獎勵，報名時自動折扣：
            </p>

            <div className="bg-gray-900/50 rounded-lg p-6 mb-4 text-center">
              <div className="text-sm text-gray-400 mb-2">報名立減</div>
              <div className="text-5xl font-bold text-green-400 mb-3">
                NT$ {DISCOUNT_AMOUNT}
              </div>
              <div className="text-sm text-gray-300 bg-green-500/10 rounded px-4 py-3 border border-green-400/20">
                ✨ 系統已記錄你的探索者資格，點擊報名時會自動套用折扣
              </div>
            </div>

            <a
              href={`/buy-course/${courseId}`}
              className="block w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white font-bold py-3 px-6 rounded-lg transition-all text-center shadow-lg"
            >
              立即報名（已享 NT$ {DISCOUNT_AMOUNT} 折扣）→
            </a>

            <p className="text-xs text-gray-400 mt-3 text-center">
              💡 提示：你的探索者資格已儲存，報名時會自動折抵 {DISCOUNT_AMOUNT} 元
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
