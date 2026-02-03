import type { Payload } from 'payload'
import type { Profile, Post } from '@/payload-types'
import { createHash } from 'node:crypto'

/**
 * AT Protocol Adapter
 * Implements Bluesky's Authenticated Transfer Protocol for decentralized social networking
 *
 * Key concepts:
 * - DID (Decentralized Identifier): Unique identifier for accounts
 * - PDS (Personal Data Server): Hosts user's data repository
 * - Lexicon: Schema definitions for records
 * - XRPC: Cross-server RPC protocol
 */

export interface DIDDocument {
  '@context': string[]
  id: string
  alsoKnownAs?: string[]
  verificationMethod: Array<{
    id: string
    type: string
    controller: string
    publicKeyMultibase: string
  }>
  service: Array<{
    id: string
    type: string
    serviceEndpoint: string
  }>
}

export interface AtProtoProfile {
  $type: 'app.bsky.actor.profile'
  displayName?: string
  description?: string
  avatar?: {
    $type: 'blob'
    ref: {
      $link: string
    }
    mimeType: string
    size: number
  }
}

export interface AtProtoPost {
  $type: 'app.bsky.feed.post'
  text: string
  facets?: Array<{
    index: { byteStart: number; byteEnd: number }
    features: Array<{
      $type: string
      [key: string]: any
    }>
  }>
  embed?: {
    $type: string
    [key: string]: any
  }
  langs?: string[]
  createdAt: string
  reply?: {
    root: { uri: string; cid: string }
    parent: { uri: string; cid: string }
  }
}

export interface AtProtoLike {
  $type: 'app.bsky.feed.like'
  subject: {
    uri: string
    cid: string
  }
  createdAt: string
}

export interface AtProtoFollow {
  $type: 'app.bsky.graph.follow'
  subject: string // DID
  createdAt: string
}

export interface Session {
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
  email?: string
}

/**
 * AT Protocol Adapter for Bluesky Integration
 */
export class AtProtoAdapter {
  private baseUrl: string
  private pdsUrl: string
  private sessions: Map<string, Session> = new Map()

  constructor(
    private payload: Payload,
    baseUrl?: string,
    pdsUrl?: string
  ) {
    this.baseUrl = baseUrl || process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:3000'
    this.pdsUrl = pdsUrl || process.env.ATPROTO_PDS_URL || 'https://bsky.social'
  }

  /**
   * Create DID document for a profile
   */
  async createDIDDocument(profile: Profile): Promise<DIDDocument> {
    // Generate DID using did:web method
    const domain = new URL(this.baseUrl).hostname
    const did = `did:web:${domain}:${profile.username}`

    // Generate key pair for signing
    const { publicKey } = await this.generateKeyPair()
    const publicKeyMultibase = this.encodeMultibase(publicKey)

    // Store DID in database
    await this.payload.update({
      collection: 'profiles',
      id: profile.id,
      data: {
        // @ts-ignore - custom fields
        atprotoDID: did,
        atprotoPublicKey: publicKey
      }
    })

    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1'
      ],
      id: did,
      alsoKnownAs: [`at://${profile.username}.${domain}`],
      verificationMethod: [
        {
          id: `${did}#atproto`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase
        }
      ],
      service: [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: this.baseUrl
        }
      ]
    }
  }

  /**
   * Create AT Protocol session (login)
   */
  async createSession(
    identifier: string,
    password: string
  ): Promise<Session> {
    const response = await fetch(`${this.pdsUrl}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ identifier, password })
    })

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.status}`)
    }

    const session = await response.json() as Session
    this.sessions.set(session.did, session)

    return session
  }

  /**
   * Refresh session token
   */
  async refreshSession(refreshJwt: string): Promise<Session> {
    const response = await fetch(`${this.pdsUrl}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshJwt}`
      }
    })

    if (!response.ok) {
      throw new Error(`Failed to refresh session: ${response.status}`)
    }

    const session = await response.json() as Session
    this.sessions.set(session.did, session)

    return session
  }

  /**
   * Get session for a profile
   */
  private async getSession(profile: Profile): Promise<Session | null> {
    // @ts-ignore - custom field
    const did = profile.atprotoDID
    if (!did) {
      return null
    }

    return this.sessions.get(did) || null
  }

  /**
   * Create AT Protocol profile record
   */
  async createProfile(profile: Profile): Promise<void> {
    const session = await this.getSession(profile)
    if (!session) {
      throw new Error('No session found for profile')
    }

    const profileRecord: AtProtoProfile = {
      $type: 'app.bsky.actor.profile',
      displayName: profile.displayName,
      description: profile.bio || undefined
    }

    // Upload avatar if present
    if (profile.avatar) {
      const avatarUrl = typeof profile.avatar === 'string' ? profile.avatar : profile.avatar.url
      const avatarBlob = await this.uploadBlob(session, avatarUrl)
      profileRecord.avatar = avatarBlob
    }

    await this.putRecord(
      session,
      'app.bsky.actor.profile',
      'self',
      profileRecord
    )
  }

  /**
   * Publish post to Bluesky
   */
  async publishPost(post: Post): Promise<string> {
    const author =
      typeof post.author === 'string'
        ? await this.payload.findByID({ collection: 'profiles', id: post.author })
        : post.author

    const session = await this.getSession(author)
    if (!session) {
      throw new Error('No session found for author')
    }

    // Build post record
    const postRecord: AtProtoPost = {
      $type: 'app.bsky.feed.post',
      text: post.contentText,
      langs: ['en'],
      createdAt: new Date().toISOString()
    }

    // Add facets (mentions, links, hashtags)
    const facets = this.extractFacets(post.contentText)
    if (facets.length > 0) {
      postRecord.facets = facets
    }

    // Create record
    const result = await this.createRecord(
      session,
      'app.bsky.feed.post',
      postRecord
    )

    // Store AT URI in database
    await this.payload.update({
      collection: 'posts',
      id: post.id,
      data: {
        // @ts-ignore - custom field
        atprotoUri: result.uri,
        atprotoCid: result.cid
      }
    })

    this.payload.logger.info(`Published post to Bluesky: ${result.uri}`)

    return result.uri
  }

  /**
   * Follow a Bluesky user
   */
  async followUser(profile: Profile, targetDID: string): Promise<void> {
    const session = await this.getSession(profile)
    if (!session) {
      throw new Error('No session found for profile')
    }

    const followRecord: AtProtoFollow = {
      $type: 'app.bsky.graph.follow',
      subject: targetDID,
      createdAt: new Date().toISOString()
    }

    await this.createRecord(session, 'app.bsky.graph.follow', followRecord)
  }

  /**
   * Like a post
   */
  async likePost(
    profile: Profile,
    postUri: string,
    postCid: string
  ): Promise<void> {
    const session = await this.getSession(profile)
    if (!session) {
      throw new Error('No session found for profile')
    }

    const likeRecord: AtProtoLike = {
      $type: 'app.bsky.feed.like',
      subject: {
        uri: postUri,
        cid: postCid
      },
      createdAt: new Date().toISOString()
    }

    await this.createRecord(session, 'app.bsky.feed.like', likeRecord)
  }

  /**
   * Get user's timeline
   */
  async getTimeline(profile: Profile, limit: number = 50): Promise<any[]> {
    const session = await this.getSession(profile)
    if (!session) {
      throw new Error('No session found for profile')
    }

    const response = await fetch(
      `${this.pdsUrl}/xrpc/app.bsky.feed.getTimeline?limit=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${session.accessJwt}`
        }
      }
    )

    if (!response.ok) {
      throw new Error(`Failed to get timeline: ${response.status}`)
    }

    const data = await response.json()
    return data.feed || []
  }

  /**
   * Search for posts
   */
  async searchPosts(query: string, limit: number = 25): Promise<any[]> {
    const response = await fetch(
      `${this.pdsUrl}/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${limit}`
    )

    if (!response.ok) {
      throw new Error(`Failed to search posts: ${response.status}`)
    }

    const data = await response.json()
    return data.posts || []
  }

  /**
   * Create a record in the repository
   */
  private async createRecord(
    session: Session,
    collection: string,
    record: object
  ): Promise<{ uri: string; cid: string }> {
    const response = await fetch(`${this.pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessJwt}`
      },
      body: JSON.stringify({
        repo: session.did,
        collection,
        record
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to create record: ${response.status}`)
    }

    return response.json()
  }

  /**
   * Put a record (create or update)
   */
  private async putRecord(
    session: Session,
    collection: string,
    rkey: string,
    record: object
  ): Promise<{ uri: string; cid: string }> {
    const response = await fetch(`${this.pdsUrl}/xrpc/com.atproto.repo.putRecord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessJwt}`
      },
      body: JSON.stringify({
        repo: session.did,
        collection,
        rkey,
        record
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to put record: ${response.status}`)
    }

    return response.json()
  }

  /**
   * Upload blob (image, video, etc.)
   */
  private async uploadBlob(
    session: Session,
    fileUrl: string
  ): Promise<{
    $type: 'blob'
    ref: { $link: string }
    mimeType: string
    size: number
  }> {
    // Fetch file
    const fileResponse = await fetch(fileUrl)
    const fileData = await fileResponse.arrayBuffer()
    const mimeType = fileResponse.headers.get('content-type') || 'application/octet-stream'

    // Upload to PDS
    const response = await fetch(`${this.pdsUrl}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: {
        'Content-Type': mimeType,
        Authorization: `Bearer ${session.accessJwt}`
      },
      body: fileData
    })

    if (!response.ok) {
      throw new Error(`Failed to upload blob: ${response.status}`)
    }

    const data = await response.json()
    return data.blob
  }

  /**
   * Extract facets (mentions, links, hashtags) from text
   */
  private extractFacets(text: string): Array<{
    index: { byteStart: number; byteEnd: number }
    features: Array<{ $type: string; [key: string]: any }>
  }> {
    const facets: Array<{
      index: { byteStart: number; byteEnd: number }
      features: Array<{ $type: string; [key: string]: any }>
    }> = []

    // Find mentions (@username)
    const mentionRegex = /@([a-zA-Z0-9_.-]+)/g
    let match: RegExpExecArray | null
    while ((match = mentionRegex.exec(text)) !== null) {
      const bytes = Buffer.from(text.slice(0, match.index))
      const byteStart = bytes.length
      const byteEnd = byteStart + Buffer.from(match[0]).length

      facets.push({
        index: { byteStart, byteEnd },
        features: [
          {
            $type: 'app.bsky.richtext.facet#mention',
            did: `did:plc:${match[1]}` // Simplified - would need DID resolution
          }
        ]
      })
    }

    // Find hashtags (#tag)
    const hashtagRegex = /#([a-zA-Z0-9_]+)/g
    while ((match = hashtagRegex.exec(text)) !== null) {
      const bytes = Buffer.from(text.slice(0, match.index))
      const byteStart = bytes.length
      const byteEnd = byteStart + Buffer.from(match[0]).length

      facets.push({
        index: { byteStart, byteEnd },
        features: [
          {
            $type: 'app.bsky.richtext.facet#tag',
            tag: match[1]
          }
        ]
      })
    }

    // Find links (http/https URLs)
    const linkRegex = /(https?:\/\/[^\s]+)/g
    while ((match = linkRegex.exec(text)) !== null) {
      const bytes = Buffer.from(text.slice(0, match.index))
      const byteStart = bytes.length
      const byteEnd = byteStart + Buffer.from(match[0]).length

      facets.push({
        index: { byteStart, byteEnd },
        features: [
          {
            $type: 'app.bsky.richtext.facet#link',
            uri: match[0]
          }
        ]
      })
    }

    return facets.sort((a, b) => a.index.byteStart - b.index.byteStart)
  }

  /**
   * Generate key pair for DID
   */
  private async generateKeyPair(): Promise<{
    publicKey: string
    privateKey: string
  }> {
    const { generateKeyPairSync } = await import('node:crypto')

    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    })

    return { publicKey, privateKey }
  }

  /**
   * Encode public key in multibase format
   */
  private encodeMultibase(publicKeyPem: string): string {
    // Extract raw key from PEM
    const base64 = publicKeyPem
      .replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '')
      .replace(/\s/g, '')

    const keyBytes = Buffer.from(base64, 'base64')

    // Multibase encoding (base58btc with 'z' prefix)
    // Simplified - real implementation would use @multiformats/multibase
    return 'z' + keyBytes.toString('base64url')
  }

  /**
   * Resolve DID to DID document
   */
  async resolveDID(did: string): Promise<DIDDocument> {
    if (did.startsWith('did:web:')) {
      // Resolve did:web
      const domain = did.replace('did:web:', '').replace(/:/g, '/')
      const didDocUrl = `https://${domain}/.well-known/did.json`

      const response = await fetch(didDocUrl)
      if (!response.ok) {
        throw new Error(`Failed to resolve DID: ${response.status}`)
      }

      return response.json()
    } else if (did.startsWith('did:plc:')) {
      // Resolve did:plc (Placeholder DID method)
      const response = await fetch(`https://plc.directory/${did}`)
      if (!response.ok) {
        throw new Error(`Failed to resolve DID: ${response.status}`)
      }

      return response.json()
    }

    throw new Error(`Unsupported DID method: ${did}`)
  }

  /**
   * Import posts from Bluesky timeline
   */
  async importTimelinePosts(profile: Profile, limit: number = 50): Promise<void> {
    const timeline = await this.getTimeline(profile, limit)

    for (const item of timeline) {
      const blueskyPost = item.post
      if (!blueskyPost) continue

      // Check if post already imported
      const existing = await this.payload.find({
        collection: 'posts',
        where: {
          // @ts-ignore - custom field
          atprotoUri: { equals: blueskyPost.uri }
        },
        limit: 1
      })

      if (existing.docs[0]) {
        continue
      }

      // Get or create author profile
      const authorDID = blueskyPost.author.did
      let authorProfile = await this.findProfileByDID(authorDID)

      if (!authorProfile) {
        // Create profile for remote Bluesky user
        authorProfile = await this.payload.create({
          collection: 'profiles',
          data: {
            type: 'human',
            username: `${blueskyPost.author.handle}@bsky.social`,
            displayName: blueskyPost.author.displayName || blueskyPost.author.handle,
            bio: blueskyPost.author.description,
            // @ts-ignore - custom fields
            atprotoDID: authorDID,
            federatedSource: 'atproto',
            remoteInstance: 'bsky.social'
          }
        })
      }

      // Import post
      await this.payload.create({
        collection: 'posts',
        data: {
          author: authorProfile.id,
          authorType: authorProfile.type === 'agent' ? 'agent' : 'human',
          content: { root: { children: [{ text: blueskyPost.record.text }] } },
          contentText: blueskyPost.record.text,
          visibility: 'public',
          // @ts-ignore - custom fields
          atprotoUri: blueskyPost.uri,
          atprotoCid: blueskyPost.cid,
          federatedSource: 'atproto'
        }
      })
    }

    this.payload.logger.info(`Imported ${timeline.length} posts from Bluesky timeline`)
  }

  /**
   * Find profile by AT Proto DID
   */
  private async findProfileByDID(did: string): Promise<Profile | null> {
    const result = await this.payload.find({
      collection: 'profiles',
      where: {
        // @ts-ignore - custom field
        atprotoDID: { equals: did }
      },
      limit: 1
    })

    return result.docs[0] || null
  }
}

/**
 * Get AT Protocol service instance
 */
export function getAtProtoAdapter(payload: Payload): AtProtoAdapter {
  return new AtProtoAdapter(payload)
}
