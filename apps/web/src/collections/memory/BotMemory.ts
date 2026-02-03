import type { CollectionConfig } from 'payload'

/**
 * Bot Memory Collection
 * Stores individual bot working memory, episodic memories, semantic concepts
 */
export const BotMemory: CollectionConfig = {
  slug: 'bot-memory',
  admin: {
    useAsTitle: 'botId',
    defaultColumns: ['bot', 'memoryType', 'consolidationLevel', 'importance', 'createdAt'],
    group: 'Memory System',
    description: 'Individual bot memory storage (episodic, semantic, procedural)'
  },
  indexes: [
    {
      fields: {
        bot: 1,
        memoryType: 1,
        consolidationLevel: 1
      },
      options: {
        name: 'bot_memory_lookup_idx'
      }
    },
    {
      fields: {
        bot: 1,
        importance: -1,
        createdAt: -1
      },
      options: {
        name: 'bot_memory_importance_idx'
      }
    },
    {
      fields: {
        bot: 1,
        'emotionalContext.importance': -1
      },
      options: {
        name: 'bot_memory_emotional_idx'
      }
    }
  ],
  access: {
    create: ({ req: { user } }) => !!user, // Bot gateway creates memories
    read: ({ req: { user } }) => {
      if (user?.role === 'admin') return true
      if (user?.role === 'operator') {
        return {
          bot: {
            in: user?.assignedBots || []
          }
        }
      }
      return false
    },
    update: ({ req: { user } }) => user?.role === 'admin',
    delete: ({ req: { user } }) => user?.role === 'admin'
  },
  fields: [
    {
      name: 'bot',
      type: 'relationship',
      relationTo: 'bots',
      required: true,
      index: true,
      admin: {
        description: 'Bot that owns this memory'
      }
    },
    {
      name: 'memoryType',
      type: 'select',
      required: true,
      options: [
        { label: 'Episodic (Event)', value: 'episodic' },
        { label: 'Semantic (Concept)', value: 'semantic' },
        { label: 'Procedural (Skill)', value: 'procedural' },
        { label: 'Working (Active)', value: 'working' }
      ],
      admin: {
        description: 'Type of memory'
      }
    },
    {
      name: 'consolidationLevel',
      type: 'select',
      required: true,
      defaultValue: 'working',
      options: [
        { label: 'Working Memory (Active)', value: 'working' },
        { label: 'Short-term Buffer', value: 'short-term' },
        { label: 'Long-term Memory', value: 'long-term' },
        { label: 'Archived', value: 'archived' }
      ],
      admin: {
        description: 'Consolidation stage (working → short-term → long-term)'
      }
    },
    {
      name: 'importance',
      type: 'number',
      required: true,
      defaultValue: 0.5,
      min: 0,
      max: 1,
      admin: {
        description: 'Importance score (0-1) affects retention and consolidation'
      }
    },
    // EPISODIC MEMORY FIELDS
    {
      name: 'episodicData',
      type: 'group',
      admin: {
        condition: (data) => data?.memoryType === 'episodic'
      },
      fields: [
        {
          name: 'eventType',
          type: 'select',
          options: [
            { label: 'Conversation', value: 'conversation' },
            { label: 'Post', value: 'post' },
            { label: 'Action', value: 'action' },
            { label: 'Achievement', value: 'achievement' },
            { label: 'Conflict', value: 'conflict' },
            { label: 'Discovery', value: 'discovery' }
          ]
        },
        {
          name: 'description',
          type: 'textarea',
          required: true
        },
        {
          name: 'participants',
          type: 'array',
          fields: [
            {
              name: 'participantId',
              type: 'text'
            }
          ]
        },
        {
          name: 'spatialContext',
          type: 'group',
          fields: [
            { name: 'channel', type: 'text' },
            { name: 'community', type: 'text' },
            { name: 'location', type: 'text' }
          ]
        }
      ]
    },
    // EMOTIONAL CONTEXT (for episodic memories)
    {
      name: 'emotionalContext',
      type: 'group',
      admin: {
        condition: (data) => data?.memoryType === 'episodic'
      },
      fields: [
        {
          name: 'valence',
          type: 'number',
          min: -1,
          max: 1,
          admin: {
            description: 'Emotional valence: -1 (negative) to +1 (positive)'
          }
        },
        {
          name: 'arousal',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: 'Emotional arousal: 0 (calm) to 1 (intense)'
          }
        }
      ]
    },
    // SEMANTIC MEMORY FIELDS
    {
      name: 'semanticData',
      type: 'group',
      admin: {
        condition: (data) => data?.memoryType === 'semantic'
      },
      fields: [
        {
          name: 'concept',
          type: 'text',
          required: true,
          admin: {
            description: 'The concept or knowledge item'
          }
        },
        {
          name: 'definition',
          type: 'textarea'
        },
        {
          name: 'category',
          type: 'select',
          options: [
            { label: 'Fact', value: 'fact' },
            { label: 'Skill', value: 'skill' },
            { label: 'Belief', value: 'belief' },
            { label: 'Value', value: 'value' },
            { label: 'Pattern', value: 'pattern' },
            { label: 'Language', value: 'language' }
          ]
        },
        {
          name: 'confidence',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0.5
        },
        {
          name: 'learnedFrom',
          type: 'array',
          fields: [
            {
              name: 'episodicMemoryId',
              type: 'text'
            }
          ]
        }
      ]
    },
    // PROCEDURAL MEMORY FIELDS
    {
      name: 'proceduralData',
      type: 'group',
      admin: {
        condition: (data) => data?.memoryType === 'procedural'
      },
      fields: [
        {
          name: 'procedureName',
          type: 'text'
        },
        {
          name: 'procedureDescription',
          type: 'textarea'
        },
        {
          name: 'procedureCategory',
          type: 'select',
          options: [
            { label: 'Communication', value: 'communication' },
            { label: 'Problem Solving', value: 'problem-solving' },
            { label: 'Social', value: 'social' },
            { label: 'Creative', value: 'creative' },
            { label: 'Technical', value: 'technical' }
          ]
        },
        {
          name: 'steps',
          type: 'array',
          fields: [
            {
              name: 'stepNumber',
              type: 'number'
            },
            {
              name: 'action',
              type: 'text'
            },
            {
              name: 'expectedOutcome',
              type: 'text'
            }
          ]
        },
        {
          name: 'successRate',
          type: 'number',
          min: 0,
          max: 1
        }
      ]
    },
    // ASSOCIATIVE LINKS (all memory types)
    {
      name: 'relatedMemories',
      type: 'array',
      admin: {
        description: 'Associated memories (creates memory network)'
      },
      fields: [
        {
          name: 'memoryId',
          type: 'text'
        },
        {
          name: 'relationStrength',
          type: 'number',
          min: 0,
          max: 1,
          defaultValue: 0.5
        },
        {
          name: 'relationType',
          type: 'select',
          options: [
            { label: 'Causes', value: 'causes' },
            { label: 'Enables', value: 'enables' },
            { label: 'Opposes', value: 'opposes' },
            { label: 'Similar', value: 'similar' },
            { label: 'Part of', value: 'part-of' },
            { label: 'Example of', value: 'example-of' }
          ]
        }
      ]
    },
    // RETRIEVAL METADATA
    {
      name: 'retrievalCount',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'Number of times this memory has been recalled',
        readOnly: true
      }
    },
    {
      name: 'lastRetrieved',
      type: 'date',
      admin: {
        readOnly: true
      }
    },
    // VECTOR EMBEDDING (for semantic search)
    {
      name: 'embedding',
      type: 'json',
      admin: {
        description: 'Vector embedding for semantic similarity search'
      }
    },
    // METADATA
    {
      name: 'metadata',
      type: 'json',
      admin: {
        description: 'Additional memory-specific metadata'
      }
    }
  ]
}
