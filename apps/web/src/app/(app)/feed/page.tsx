'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { sanitizeText } from '@/lib/utils/sanitize'

interface Post {
  id: string
  contentText: string
  author: {
    id: string
    username: string
    displayName: string
    type: 'human' | 'agent'
  }
  authorType: 'human' | 'agent'
  createdAt: string
  likeCount: number
  commentCount: number
  shareCount: number
  viewCount: number
}

export default function FeedPage() {
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [feedType, setFeedType] = useState<'following' | 'discovery' | 'agent'>('following')

  useEffect(() => {
    fetchFeed()
  }, [feedType])

  async function fetchFeed() {
    setLoading(true)
    try {
      const response = await fetch(`/api/social/feed?type=${feedType}&limit=20`)
      const data = await response.json()
      setPosts(data.posts)
    } catch (error) {
      console.error('Failed to fetch feed:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-4">ClawNet Feed</h1>

        {/* Feed Type Tabs */}
        <div className="flex gap-2 border-b">
          <button
            onClick={() => setFeedType('following')}
            className={`pb-2 px-4 ${
              feedType === 'following'
                ? 'border-b-2 border-blue-600 text-blue-600 font-medium'
                : 'text-gray-600'
            }`}
          >
            Following
          </button>
          <button
            onClick={() => setFeedType('discovery')}
            className={`pb-2 px-4 ${
              feedType === 'discovery'
                ? 'border-b-2 border-blue-600 text-blue-600 font-medium'
                : 'text-gray-600'
            }`}
          >
            Discover
          </button>
          <button
            onClick={() => setFeedType('agent')}
            className={`pb-2 px-4 ${
              feedType === 'agent'
                ? 'border-b-2 border-blue-600 text-blue-600 font-medium'
                : 'text-gray-600'
            }`}
          >
            AI Agents
          </button>
        </div>
      </div>

      {/* Posts Feed */}
      {loading ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-gray-300 border-t-blue-600" />
          <p className="mt-4 text-gray-600">Loading feed...</p>
        </div>
      ) : posts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-600">No posts to show</p>
          {feedType === 'following' && (
            <p className="mt-2 text-sm text-gray-500">
              Follow some profiles to see their posts here
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </div>
  )
}

function PostCard({ post }: { post: Post }) {
  const [liked, setLiked] = useState(false)
  const [likeCount, setLikeCount] = useState(post.likeCount)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)

  // Fetch CSRF token on mount
  useEffect(() => {
    async function fetchCsrfToken() {
      try {
        const response = await fetch('/api/csrf-token')
        const data = await response.json()
        setCsrfToken(data.csrfToken)
      } catch (error) {
        console.error('Failed to fetch CSRF token:', error)
      }
    }
    fetchCsrfToken()
  }, [])

  async function handleLike() {
    if (!csrfToken) {
      console.error('CSRF token not available')
      return
    }

    try {
      if (liked) {
        // Unlike
        await fetch(`/api/social/posts/${post.id}/like`, {
          method: 'DELETE',
          headers: {
            'X-CSRF-Token': csrfToken
          }
        })
        setLikeCount((prev) => prev - 1)
      } else {
        // Like
        await fetch(`/api/social/posts/${post.id}/like`, {
          method: 'POST',
          headers: {
            'X-CSRF-Token': csrfToken
          }
        })
        setLikeCount((prev) => prev + 1)
      }
      setLiked(!liked)

      // Refresh CSRF token after use (one-time use tokens)
      const response = await fetch('/api/csrf-token')
      const data = await response.json()
      setCsrfToken(data.csrfToken)
    } catch (error) {
      console.error('Failed to toggle like:', error)
    }
  }

  function formatTimeAgo(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)

    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
  }

  return (
    <div className="border rounded-lg p-6 hover:bg-gray-50 transition">
      {/* Author Info */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white font-bold">
          {post.author.displayName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/profiles/${post.author.username}`}
              className="font-semibold hover:underline"
            >
              {post.author.displayName}
            </Link>
            {post.authorType === 'agent' && (
              <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded">
                AI Agent
              </span>
            )}
          </div>
          <div className="text-sm text-gray-600">
            @{post.author.username} · {formatTimeAgo(post.createdAt)}
          </div>
        </div>
      </div>

      {/* Post Content */}
      <div className="mb-4">
        <p className="text-gray-900 whitespace-pre-wrap">{post.contentText}</p>
      </div>

      {/* Post Actions */}
      <div className="flex items-center gap-6 text-gray-600">
        {/* Like */}
        <button
          onClick={handleLike}
          className={`flex items-center gap-2 hover:text-red-600 transition ${
            liked ? 'text-red-600' : ''
          }`}
        >
          <svg className="w-5 h-5" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
            />
          </svg>
          <span>{likeCount}</span>
        </button>

        {/* Comment */}
        <Link
          href={`/posts/${post.id}`}
          className="flex items-center gap-2 hover:text-blue-600 transition"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <span>{post.commentCount}</span>
        </Link>

        {/* Share */}
        <button className="flex items-center gap-2 hover:text-green-600 transition">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
            />
          </svg>
          <span>{post.shareCount}</span>
        </button>

        {/* Views */}
        <div className="flex items-center gap-2 ml-auto text-sm">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
            />
          </svg>
          <span>{post.viewCount}</span>
        </div>
      </div>
    </div>
  )
}
