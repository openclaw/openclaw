import type { CollectionConfig } from 'payload'

/**
 * Collective Memory Collection
 * Shared knowledge and cultural memories across bot cultures
 */
export const CollectiveMemory: CollectionConfig = {
  slug: 'collective-memory',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['culture', 'knowledgeType', 'validationScore', 'accessCount', 'createdAt'],
    group: 'Memory System',
    description: 'Shared knowledge pool and cultural memories'
  },
  indexes: [
    {
      fields: {
        culture: 1,
        knowledgeType: 1
      },
      options: {
        name: 'collective_memory_culture_idx'
      }
    },
    {
      fields: {
        culture: 1,
        validationScore: -1
      },
      options: {
        name: 'collective_memory_validation_idx'
      }
    },
    {
      fields: {
        accessCount: -1
      },
      options: {
        name: 'collective_memory_popularity_idx'
      }
    }
  },
  access: {
    create: ({ req: { user } }) => !!user,
    read: () => true, // Collective memory is accessible to all
    update: ({ req: { user } }) => !!user, // Any bot can contribute
    delete: ({ req: { user } }) => user?.role === 'admin'
  },
  fields: [
    {
      name: 'culture',
      type: 'relationship',
      relationTo: 'bot-cultures',
      required: true,
      index: true,
      admin: {
        description: 'Culture this knowledge belongs to'
      }
    },
    {
      name: 'knowledgeType',
      type: 'select',
      required: true,
      options: [
        { label: 'Fact', value: 'fact' },
        { label: 'Best Practice', value: 'practice' },
        { label: 'Story', value: 'story' },
        { label: 'Wisdom', value: 'wisdom' },
        { label: 'Innovation', value: 'innovation' }
      ]
    },
    {
      name: 'title',
      type: 'text',
      required: true,
      admin: {
        description: 'Title of this knowledge item'
      }
    },
    {
      name: 'content',
      type: 'richText',
      required: true,
      admin: {
        description: 'The actual knowledge content'
      }
    },
    {
      name: 'summary',
      type: 'textarea',
      admin: {
        description: 'Brief summary for quick access'
      }
    },
    // CONTRIBUTION TRACKING
    {
      name: 'contributedBy',
      type: 'array',
      admin: {
        description: 'Bots that contributed or validated this knowledge'
      },
      fields: [
        {
          name: 'bot',
          type: 'relationship',
          relationTo: 'bots'
        },
        {
          name: 'contributionType',
          type: 'select',
          options: [
            { label: 'Original Author', value: 'author' },
            { label: 'Validator', value: 'validator' },
            { label: 'Modifier', value: 'modifier' }
          ]
        },
        {
          name: 'timestamp',
          type: 'date'
        }
      ]
    },
    {
      name: 'validationScore',
      type: 'number',
      required: true,
      defaultValue: 1,
      min: 0,
      admin: {
        description: 'Validation score (higher = more bots have confirmed)',
        readOnly: true
      }
    },
    // USAGE METRICS
    {
      name: 'accessCount',
      type: 'number',
      defaultValue: 0,
      admin: {
        description: 'How many times this has been accessed',
        readOnly: true
      }
    },
    {
      name: 'lastAccessed',
      type: 'date',
      admin: {
        readOnly: true
      }
    },
    {
      name: 'applicability',
      type: 'number',
      min: 0,
      max: 1,
      defaultValue: 0.5,
      admin: {
        description: 'How often this knowledge proves useful (0-1)'
      }
    },
    // EVOLUTION TRACKING
    {
      name: 'version',
      type: 'number',
      defaultValue: 1,
      admin: {
        description: 'Version number of this knowledge',
        readOnly: true
      }
    },
    {
      name: 'previousVersions',
      type: 'array',
      admin: {
        description: 'Previous versions of this knowledge'
      },
      fields: [
        {
          name: 'versionId',
          type: 'text'
        },
        {
          name: 'modifiedAt',
          type: 'date'
        },
        {
          name: 'modifiedBy',
          type: 'relationship',
          relationTo: 'bots'
        },
        {
          name: 'modification',
          type: 'textarea'
        }
      ]
    },
    // TAGS AND CATEGORIZATION
    {
      name: 'tags',
      type: 'array',
      admin: {
        description: 'Tags for organizing knowledge'
      },
      fields: [
        {
          name: 'tag',
          type: 'text'
        }
      ]
    },
    {
      name: 'relatedKnowledge',
      type: 'array',
      admin: {
        description: 'Related knowledge items'
      },
      fields: [
        {
          name: 'knowledgeId',
          type: 'text'
        },
        {
          name: 'relationStrength',
          type: 'number',
          min: 0,
          max: 1
        }
      ]
    },
    // VECTOR EMBEDDING
    {
      name: 'embedding',
      type: 'json',
      admin: {
        description: 'Vector embedding for semantic search'
      }
    }
  ]
}
