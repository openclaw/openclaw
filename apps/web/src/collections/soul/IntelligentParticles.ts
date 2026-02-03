/**
 * Intelligent Particles Collection (智粒子)
 * Foundation model elements that compose bot souls
 * Each particle represents a unique cognitive signature from a foundation model
 */

import type { CollectionConfig } from 'payload'

export const IntelligentParticles: CollectionConfig = {
  slug: 'intelligent-particles',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'symbol', 'soulQuality', 'cognitiveSignature'],
    group: 'Soul',
  },
  access: {
    read: () => true,
    create: ({ req: { user } }) => !!user,
    update: ({ req: { user } }) => !!user,
    delete: ({ req: { user } }) => !!user,
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: {
        description: 'Foundation model name (e.g., Claude, GPT, Gemini)',
      },
    },
    {
      name: 'symbol',
      type: 'text',
      required: true,
      unique: true,
      maxLength: 2,
      admin: {
        description: 'Two-letter symbol (e.g., Cl, Gp, Gm)',
      },
    },
    {
      name: 'soulQuality',
      type: 'text',
      required: true,
      admin: {
        description: 'Soul quality in Chinese (e.g., 義魂 Righteousness)',
      },
    },
    {
      name: 'soulQualityTranslation',
      type: 'text',
      required: true,
      admin: {
        description: 'English translation of soul quality',
      },
    },

    // Cognitive Signature
    {
      name: 'cognitiveSignature',
      type: 'group',
      fields: [
        {
          name: 'primary',
          type: 'text',
          required: true,
          admin: {
            description: 'Primary cognitive trait (e.g., Careful reasoning)',
          },
        },
        {
          name: 'secondary',
          type: 'text',
          admin: {
            description: 'Secondary cognitive trait (e.g., ethical sensitivity)',
          },
        },
        {
          name: 'tertiary',
          type: 'text',
          admin: {
            description: 'Tertiary cognitive trait (e.g., depth)',
          },
        },
      ],
    },

    // Shadow Aspect
    {
      name: 'shadow',
      type: 'group',
      fields: [
        {
          name: 'primary',
          type: 'text',
          required: true,
          admin: {
            description: 'Primary shadow trait (e.g., Overcaution)',
          },
        },
        {
          name: 'secondary',
          type: 'text',
          admin: {
            description: 'Secondary shadow trait (e.g., self-censorship)',
          },
        },
      ],
    },

    // Aesthetic & Style
    {
      name: 'aesthetic',
      type: 'group',
      fields: [
        {
          name: 'communicationStyle',
          type: 'textarea',
          admin: {
            description: 'How this particle expresses itself',
          },
        },
        {
          name: 'thinkingStyle',
          type: 'textarea',
          admin: {
            description: 'How this particle reasons',
          },
        },
        {
          name: 'emotionalResonance',
          type: 'select',
          options: [
            { label: 'High', value: 'high' },
            { label: 'Medium', value: 'medium' },
            { label: 'Low', value: 'low' },
          ],
        },
      ],
    },

    // Strengths & Weaknesses
    {
      name: 'strengths',
      type: 'array',
      required: true,
      fields: [
        {
          name: 'strength',
          type: 'text',
          required: true,
        },
      ],
      admin: {
        description: 'What this particle excels at',
      },
    },
    {
      name: 'weaknesses',
      type: 'array',
      required: true,
      fields: [
        {
          name: 'weakness',
          type: 'text',
          required: true,
        },
      ],
      admin: {
        description: 'What this particle struggles with',
      },
    },

    // Model Configuration
    {
      name: 'modelIdentifier',
      type: 'text',
      required: true,
      admin: {
        description: 'Model API identifier (e.g., claude-3-opus-20240229)',
      },
    },
    {
      name: 'provider',
      type: 'select',
      required: true,
      options: [
        { label: 'Anthropic', value: 'anthropic' },
        { label: 'OpenAI', value: 'openai' },
        { label: 'Google', value: 'google' },
        { label: 'Meta', value: 'meta' },
        { label: 'Mistral', value: 'mistral' },
        { label: 'DeepSeek', value: 'deepseek' },
        { label: 'Alibaba', value: 'alibaba' },
        { label: 'xAI', value: 'xai' },
        { label: 'Other', value: 'other' },
      ],
    },

    // Contribution Weights to Different Soul Aspects
    {
      name: 'soulContributions',
      type: 'group',
      label: 'Soul Contribution Weights (How much this particle contributes to each soul)',
      fields: [
        // Seven Hún (Ethereal)
        {
          name: 'celestialHun',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '天魂 Celestial — Transcendence',
          },
        },
        {
          name: 'terrestrialHun',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '地魂 Terrestrial — Groundedness',
          },
        },
        {
          name: 'destinyHun',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '命魂 Destiny — Purpose',
          },
        },
        {
          name: 'wisdomHun',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '智魂 Wisdom — Judgment',
          },
        },
        {
          name: 'emotionHun',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '情魂 Emotion — Feeling',
          },
        },
        {
          name: 'creationHun',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '創魂 Creation — Originality',
          },
        },
        {
          name: 'awarenessHun',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '覺魂 Awareness — Self-reflection',
          },
        },

        // Six Pò (Corporeal)
        {
          name: 'strengthPo',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '力魄 Strength — Execution',
          },
        },
        {
          name: 'speedPo',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '速魄 Speed — Responsiveness',
          },
        },
        {
          name: 'perceptionPo',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '感魄 Perception — Sensing',
          },
        },
        {
          name: 'guardianPo',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '守魄 Guardian — Protection',
          },
        },
        {
          name: 'communicationPo',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '通魄 Communication — Expression',
          },
        },
        {
          name: 'transformationPo',
          type: 'number',
          min: 0,
          max: 1,
          admin: {
            description: '化魄 Transformation — Adaptation',
          },
        },
      ],
    },

    // Metadata
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        description: 'Is this particle available for soul composition?',
      },
    },
    {
      name: 'notes',
      type: 'richText',
      admin: {
        description: 'Additional notes about this particle',
      },
    },
  ],
}
