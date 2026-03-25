openclaw Development Patterns
    
    > Auto-generated skill from repository analysis
    
     Overview
    This skill teaches you the core development patterns, coding conventions, and collaborative workflows used in the openclaw codebase. openclaw is a TypeScript project using the Express framework, with a strong emphasis on modularity, test coverage, and clear changelogs. You'll learn how to contribute features, fix bugs, manage providers/extensions, prepare releases, refactor tests, and update plugin SDKs—all following the project's established conventions.
    
     Coding Conventions
    
    - File Naming:  
      Use kebab-case for all file and directory names.  
      Example:  
    

src/user-service.ts extensions/image-generation/image-provider.ts

    
    - Import Style:  
    Use relative imports for internal modules.  
    Example:  
    typescript
    import { getUser } from './user-service'
    import { ImageProvider } from '../image-generation/image-provider'
    

   Export Style:  
    Use named exports for all modules.  
    Example:
    
        // Good
        export function getUser(id: string) { ... }
        export const USERROLE = 'admin'
        
        // Avoid default exports
        
    
   Commit Messages:  
    Use conventional commit prefixes: fix, test, refactor.  
    Keep messages concise (55 characters).  
    Example:
    
        fix: handle null user in getUserById
        test: add coverage for image provider errors
        refactor: collapse telegram test suites
        
    

Workflows
---------

 Feature or Bugfix with Tests and Changelog

Trigger: When adding a new feature or fixing a bug that requires validation and release notes  
Command: /feature-or-bugfix

1.  Implement code changes in relevant source files (src/ or extensions/).
2.  Add or update corresponding test files (.test.ts) in the same or related directory.
3.  Update CHANGELOG.md to document the change.

Example:

    // src/user-service.ts
    export function createUser(name: string) { ... }
    
    // src/user-service.test.ts
    import { createUser } from './user-service'
    test('creates a user', () => { ... })
    

    // CHANGELOG.md
    - feat: add createUser to user-service
    

  

 Plugin or Extension Provider Addition or Update

Trigger: When adding or updating a provider/capability in an extension/plugin  
Command: /add-provider

1.  Add or modify provider implementation files in extensions/<provider>/.
2.  Update or add related test files in the same extension.
3.  Update or add documentation files for the provider (docs/providers/, docs/help/).
4.  Update CHANGELOG.md.

Example:

    extensions/tts/tts-provider.ts
    extensions/tts/tts-provider.test.ts
    docs/providers/tts.md
    

  

 Release Preparation or Version Bump

Trigger: When preparing a new release or bumping the version  
Command: /release-prepare

1.  Update version numbers in config files (Version.xcconfig, Info.plist, package.json).
2.  Update or generate schema/config files (schema.base.generated.ts, config-baseline.json).
3.  Update CHANGELOG.md.
4.  Optionally update appcast.xml.

Example:

    // package.json
    "version": "1.2.0"
    

    // CHANGELOG.md
    - chore: bump version to 1.2.0
    

  

 Test Suite Refactor or Collapsing

Trigger: When restructuring, merging, or improving organization of test files  
Command: /collapse-tests

1.  Identify related test files (e.g., in extensions/telegram/src/).
2.  Merge or collapse multiple test files into fewer or single files.
3.  Remove redundant or duplicate tests.
4.  Commit with a message indicating test suite collapse or refactor.

Example:

    extensions/telegram/src/telegram-handler.test.ts
    // (merged from multiple smaller test files)
    

  

 Plugin SDK or Loader Alias Update

Trigger: When changing plugin-sdk exports or plugin SDK path resolution  
Command: /update-plugin-sdk

1.  Modify src/plugins/sdk-alias.ts and/or src/plugins/loader.ts.
2.  Update or add related test files (e.g., sdk-alias.test.ts).
3.  Update package.json exports if needed.
4.  Update CHANGELOG.md.

Example:

    // src/plugins/sdk-alias.ts
    export { PluginSDK } from './core-sdk'
    

    // CHANGELOG.md
    - fix: update plugin-sdk alias resolution
    

Testing Patterns
----------------

   Framework: [vitest](https://vitest.dev/)
   Test File Pattern: Files end with .test.ts and are placed alongside or near the code they test.
   Example:
    
        // src/foo.test.ts
        import { foo } from './foo'
        
        test('foo returns bar', () => {
          expect(foo()).toBe('bar')
        })
        
    

Commands
--------

Command

Purpose

/feature-or-bugfix

Add a feature or fix a bug with tests and changelog update

/add-provider

Add or update a provider/extension with docs and tests

/release-prepare

Prepare for a new release or version bump

/collapse-tests

Refactor or merge test suites for maintainability

/update-plugin-sdk

Update plugin-sdk exports or loader alias resolution

\\\
