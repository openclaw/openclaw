# frozen_string_literal: true

# =============================================================================
# DSPy.rb Signature Template — v0.34.3 API
#
# Signatures define the interface between your application and LLMs.
# They specify inputs, outputs, and task descriptions using Sorbet types.
#
# Key patterns:
#   - Use T::Enum classes for controlled outputs (not inline T.enum([...]))
#   - Use description: kwarg on fields to guide the LLM
#   - Use default values for optional fields
#   - Use Date/DateTime/Time for temporal data (auto-converted)
#   - Access results with result.field (not result[:field])
#   - Invoke with predictor.call() (not predictor.forward())
# =============================================================================

# --- Basic Signature ---

class SentimentAnalysis < DSPy::Signature
  description "Analyze sentiment of text"

  class Sentiment < T::Enum
    enums do
      Positive = new('positive')
      Negative = new('negative')
      Neutral = new('neutral')
    end
  end

  input do
    const :text, String
  end

  output do
    const :sentiment, Sentiment
    const :score, Float, description: "Confidence score from 0.0 to 1.0"
  end
end

# Usage:
#   predictor = DSPy::Predict.new(SentimentAnalysis)
#   result = predictor.call(text: "This product is amazing!")
#   result.sentiment  # => Sentiment::Positive
#   result.score      # => 0.92

# --- Signature with Date/Time Types ---

class EventScheduler < DSPy::Signature
  description "Schedule events based on requirements"

  input do
    const :event_name, String
    const :start_date, Date                     # ISO 8601: YYYY-MM-DD
    const :end_date, T.nilable(Date)            # Optional date
    const :preferred_time, DateTime             # ISO 8601 with timezone
    const :deadline, Time                       # Stored as UTC
  end

  output do
    const :scheduled_date, Date                 # LLM returns ISO string, auto-converted
    const :event_datetime, DateTime             # Preserves timezone
    const :created_at, Time                     # Converted to UTC
  end
end

# Date/Time format handling:
#   Date     → ISO 8601 (YYYY-MM-DD)
#   DateTime → ISO 8601 with timezone (YYYY-MM-DDTHH:MM:SS+00:00)
#   Time     → ISO 8601, automatically converted to UTC

# --- Signature with Default Values ---

class SmartSearch < DSPy::Signature
  description "Search with intelligent defaults"

  input do
    const :query, String
    const :max_results, Integer, default: 10
    const :language, String, default: "English"
    const :include_metadata, T::Boolean, default: false
  end

  output do
    const :results, T::Array[String]
    const :total_found, Integer
    const :search_time_ms, Float, default: 0.0       # Fallback if LLM omits
    const :cached, T::Boolean, default: false
  end
end

# Input defaults reduce boilerplate:
#   search = DSPy::Predict.new(SmartSearch)
#   result = search.call(query: "Ruby programming")
#   # max_results=10, language="English", include_metadata=false are applied

# --- Signature with Nested Structs and Field Descriptions ---

class EntityExtraction < DSPy::Signature
  description "Extract named entities from text"

  class EntityType < T::Enum
    enums do
      Person = new('person')
      Organization = new('organization')
      Location = new('location')
      DateEntity = new('date')
    end
  end

  class Entity < T::Struct
    const :name, String, description: "The entity text as it appears in the source"
    const :type, EntityType
    const :confidence, Float, description: "Extraction confidence from 0.0 to 1.0"
    const :start_offset, Integer, default: 0
  end

  input do
    const :text, String
    const :entity_types, T::Array[EntityType], default: [],
          description: "Filter to these entity types; empty means all types"
  end

  output do
    const :entities, T::Array[Entity]
    const :total_found, Integer
  end
end

# --- Signature with Union Types ---

class FlexibleClassification < DSPy::Signature
  description "Classify input with flexible result type"

  class Category < T::Enum
    enums do
      Technical = new('technical')
      Business = new('business')
      Personal = new('personal')
    end
  end

  input do
    const :text, String
  end

  output do
    const :category, Category
    const :result, T.any(Float, String),
          description: "Numeric score or text explanation depending on classification"
    const :confidence, Float
  end
end

# --- Signature with Recursive Types ---

class DocumentParser < DSPy::Signature
  description "Parse document into tree structure"

  class NodeType < T::Enum
    enums do
      Heading = new('heading')
      Paragraph = new('paragraph')
      List = new('list')
      CodeBlock = new('code_block')
    end
  end

  class TreeNode < T::Struct
    const :node_type, NodeType, description: "The type of document element"
    const :text, String, default: "", description: "Text content of the node"
    const :level, Integer, default: 0
    const :children, T::Array[TreeNode], default: []  # Self-reference → $defs in JSON Schema
  end

  input do
    const :html, String, description: "Raw HTML to parse"
  end

  output do
    const :root, TreeNode
    const :word_count, Integer
  end
end

# The schema generator creates #/$defs/TreeNode references for recursive types,
# compatible with OpenAI and Gemini structured outputs.
# Use `default: []` instead of `T.nilable(T::Array[...])` for OpenAI compatibility.

# --- Vision Signature ---

class ImageAnalysis < DSPy::Signature
  description "Analyze an image and answer questions about its content"

  input do
    const :image, DSPy::Image, description: "The image to analyze"
    const :question, String, description: "Question about the image content"
  end

  output do
    const :answer, String
    const :confidence, Float, description: "Confidence in the answer (0.0-1.0)"
  end
end

# Vision usage:
#   predictor = DSPy::Predict.new(ImageAnalysis)
#   result = predictor.call(
#     image: DSPy::Image.from_file("path/to/image.jpg"),
#     question: "What objects are visible?"
#   )
#   result.answer  # => "The image shows..."

# --- Accessing Schemas Programmatically ---
#
#   SentimentAnalysis.input_json_schema   # => { type: "object", properties: { ... } }
#   SentimentAnalysis.output_json_schema  # => { type: "object", properties: { ... } }
#
#   # Field descriptions propagate to JSON Schema
#   Entity.field_descriptions[:name]       # => "The entity text as it appears in the source"
#   Entity.field_descriptions[:confidence] # => "Extraction confidence from 0.0 to 1.0"
