# Information Architecture

## Overview

Information Architecture creates logical structures that help users find and understand information easily.

## When to Use

Website or app redesign
Large information spaces (documentation, e-commerce)
Navigation structure planning
Taxonomy and categorization
Search functionality design
User journey mapping

## Instructions

1. IA Principles & Process

**IA Process:**

1. Research & Discovery

- Interview users about mental models
- Card sorting sessions (open and closed)
- Analyze current usage patterns
- Competitive analysis

2. Structure Development

- Create organization scheme (hierarchical, faceted, etc.)
- Define categories and relationships
- Build taxonomy
- Plan navigation

3. Wireframing

- Sitemap creation
- Navigation structure
- Page templates
- User flows

4. Validation

- User testing with prototypes
- Tree testing (navigation only)
- Iterate based on feedback

---

## Organization Schemes

Hierarchical (Top-Down):

- Home → Categories → Subcategories → Products
- Clear parent-child relationships
- Good for browsing

Faceted/Filtering:

- Products filtered by multiple attributes
- User can narrow down
- Flexible combinations

Contextual:

- Related items grouped together
- Cross-links between sections
- Supports exploration

Task-Based:

- Organize by user goals/tasks
- "How do I...?" approach
- Matches mental models

---

## Navigation Types

Primary Navigation:

- Main categories
- Top of page or left sidebar
- Access from any page

Secondary Navigation:

- Sub-categories
- Related topics
- Context-specific

Breadcrumb Navigation:

- Shows user location in hierarchy
- Enables backward navigation

Footer Navigation:

- Links to important pages
- Legal/company info
- Helps with SEO

2. Card Sorting & Taxonomy

# Organize content into logical groups

```python
class InformationArchitecture:
    def conduct_card_sort(self, items):
        """Uncover user mental models"""
        return {
            'method': 'Open card sort (users create own categories)',
            'participants': 15,
            'items_sorted': len(items),
            'analysis': self.analyze_card_sort_results(items),
            'dendrograms': 'Show similarity between user groupings',
            'categories': self.identify_categories(items)
        }

    def identify_categories(self, items):
        """Find natural groupings"""
        categories = {}
        frequency = {}

        # Track how often items are grouped together
        # Find dominant groupings

        return {
            'primary_categories': self.get_primary_categories(frequency),
            'ambiguous_items': self.identify_ambiguous_items(frequency),
            'user_created_labels': self.extract_labels()
        }

    def create_taxonomy(self, categories):
        """Build hierarchical structure"""
        return {
            'level1': ['Products', 'Services', 'Support', 'Company'],
            'level2_products': ['Electronics', 'Clothing', 'Books'],
            'level3_electronics': ['Phones', 'Laptops', 'Accessories'],
            'relationships': 'Define parent-child and related items',
            'synonyms': 'Identify similar terms'
        }

    def validate_ia(self, structure):
        """Test with users"""
        return {
            'testing_method': 'Tree testing',
            'tasks': [
                'Find product return policy',
                'Locate shipping information',
                'Access account settings'
            ],
            'success_metrics': {
                'task_completion': '90% target',
                'time_to_complete': '<3 minutes',
                'satisfaction': '>4/5'
            }
        }
```

3. Sitemap & Navigation Structure
   Sitemap Example: E-commerce Site

```txt
Home
├── Products
│   ├── Electronics
│   │   ├── Phones
│   │   ├── Laptops
│   │   └── Accessories
│   ├── Clothing
│   │   ├── Men's
│   │   ├── Women's
│   │   └── Kids
│   └── Books
├── Services
│   ├── Shipping & Returns
│   ├── Extended Warranty
│   └── Installation
├── Support
│   ├── FAQ
│   ├── Contact Us
│   ├── Live Chat
│   └── Tickets
├── Account
│   ├── Orders
│   ├── Wishlist
│   ├── Returns
│   └── Settings
└── Company
    ├── About Us
    ├── Careers
    ├── Blog
    └── Affiliates
```

Navigation Labels:

- Clear and predictable
- Avoid jargon
- Match user language
- Consistent across site

4. Search & Discovery
   // Enable multiple ways to find content

```python
class DiscoverabilityStrategy {
  designSearchFunctionality() {
    return {
      search_box: {
        location: 'Header, prominent placement',
        placeholder: 'Clear example text',
        autocomplete: true,
        filters: ['Category', 'Price', 'Rating']
      },
      search_results: {
        ranking: 'Relevance + popularity + freshness',
        facets: 'Allow filtering results',
        snippets: 'Show preview and highlights'
      },
      zero_results: {
        suggestions: 'Show did you mean, popular searches',
        related: 'Show related categories'
      }
    };
  }

  designBrowsing() {
    return {
      category_pages: {
        structure: 'Subcategories + featured items',
        sorting: 'By popularity, newest, price',
        pagination: 'Load more or paginate'
      },
      related_items: {
        placement: 'Product page, cart page',
        logic: 'Similar category, trending, recommended'
      }
    };
  }
}
```

## Best Practices

✅ DO
Start with user research
Conduct card sorting studies
Use user mental models
Keep hierarchy 3 levels deep max
Use clear, simple labels
Enable multiple ways to find content
Test navigation with users
Update based on usage data
Document taxonomy
Provide search functionality

❌ DON'T
Impose organizational structure without research
Use jargon or technical terms
Make hierarchy too deep
Bury important content
Rely only on navigation (provide search)
Change navigation frequently
Create ambiguous labels
Forget about edge cases
Ignore accessibility
Assume desktop-only navigation

## IA Tips

Use clear, specific category names
Avoid nested menus when possible
Provide multiple paths to content
Show context within hierarchy (breadcrumbs)
Monitor analytics to improve structure
