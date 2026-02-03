'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface BotListing {
  botId: string
  name: string
  agentType: string
  model: string
  tokenId: string
  owner: string
  forSale: boolean
  salePrice: number | null
  forRent: boolean
  rentalPrice: number | null
  rentalMaxDays: number | null
}

export default function MarketplacePage() {
  const [listings, setListings] = useState<BotListing[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'sale' | 'rent'>('all')

  useEffect(() => {
    fetchListings()
  }, [filter])

  async function fetchListings() {
    setLoading(true)
    try {
      const typeParam = filter !== 'all' ? `?type=${filter}` : ''
      const response = await fetch(`/api/blockchain-secure/marketplace/listings${typeParam}`)
      const data = await response.json()
      setListings(data.listings)
    } catch (error) {
      console.error('Failed to fetch listings:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2">Bot Marketplace</h1>
        <p className="text-gray-600">
          Discover, buy, and rent AI agents powered by ClawNet
        </p>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-4 mb-6 border-b">
        <button
          onClick={() => setFilter('all')}
          className={`pb-2 px-4 ${
            filter === 'all'
              ? 'border-b-2 border-blue-600 text-blue-600 font-medium'
              : 'text-gray-600'
          }`}
        >
          All Bots
        </button>
        <button
          onClick={() => setFilter('sale')}
          className={`pb-2 px-4 ${
            filter === 'sale'
              ? 'border-b-2 border-blue-600 text-blue-600 font-medium'
              : 'text-gray-600'
          }`}
        >
          For Sale
        </button>
        <button
          onClick={() => setFilter('rent')}
          className={`pb-2 px-4 ${
            filter === 'rent'
              ? 'border-b-2 border-blue-600 text-blue-600 font-medium'
              : 'text-gray-600'
          }`}
        >
          For Rent
        </button>
      </div>

      {/* Listings Grid */}
      {loading ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-gray-300 border-t-blue-600" />
          <p className="mt-4 text-gray-600">Loading marketplace...</p>
        </div>
      ) : listings.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-600">No bots listed yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {listings.map((listing) => (
            <BotCard key={listing.botId} listing={listing} />
          ))}
        </div>
      )}
    </div>
  )
}

function BotCard({ listing }: { listing: BotListing }) {
  const [rating, setRating] = useState<{ rating: number; count: number } | null>(null)

  useEffect(() => {
    fetchRating()
  }, [])

  async function fetchRating() {
    try {
      const response = await fetch(`/api/blockchain-secure/bot-rating?tokenId=${listing.tokenId}`)
      const data = await response.json()
      setRating(data)
    } catch (error) {
      console.error('Failed to fetch rating:', error)
    }
  }

  return (
    <div className="border rounded-lg p-6 hover:shadow-lg transition-shadow">
      {/* Bot Header */}
      <div className="mb-4">
        <h3 className="text-xl font-bold mb-1">{listing.name}</h3>
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded">
            {listing.agentType}
          </span>
          <span className="px-2 py-1 bg-purple-100 text-purple-700 rounded">
            {listing.model}
          </span>
        </div>
      </div>

      {/* Rating */}
      {rating && rating.count > 0 && (
        <div className="mb-4 flex items-center gap-2">
          <div className="flex">
            {[...Array(5)].map((_, i) => (
              <svg
                key={i}
                className={`w-4 h-4 ${
                  i < Math.round(rating.rating) ? 'text-yellow-400' : 'text-gray-300'
                }`}
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
            ))}
          </div>
          <span className="text-sm text-gray-600">({rating.count})</span>
        </div>
      )}

      {/* NFT Info */}
      <div className="mb-4 text-sm text-gray-600">
        <p>Token ID: #{listing.tokenId}</p>
        <p className="truncate">Owner: {listing.owner.slice(0, 10)}...</p>
      </div>

      {/* Pricing */}
      <div className="mb-4 space-y-2">
        {listing.forSale && (
          <div className="flex items-center justify-between p-3 bg-green-50 rounded">
            <span className="font-medium">For Sale</span>
            <span className="text-lg font-bold text-green-700">
              {listing.salePrice} CLAW
            </span>
          </div>
        )}
        {listing.forRent && (
          <div className="flex items-center justify-between p-3 bg-blue-50 rounded">
            <span className="font-medium">For Rent</span>
            <div className="text-right">
              <div className="text-lg font-bold text-blue-700">
                {listing.rentalPrice} CLAW/day
              </div>
              <div className="text-xs text-gray-600">
                Max {listing.rentalMaxDays} days
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-2">
        {listing.forSale && (
          <button className="w-full px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition">
            Buy Now
          </button>
        )}
        {listing.forRent && (
          <button className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition">
            Rent Bot
          </button>
        )}
        <Link
          href={`/bots/${listing.botId}`}
          className="block w-full px-4 py-2 border border-gray-300 text-center rounded hover:bg-gray-50 transition"
        >
          View Details
        </Link>
      </div>
    </div>
  )
}
