# Database Adapter Patterns

## Abstract Base Class Pattern

```ruby
# lib/strong_migrations/adapters/abstract_adapter.rb
module StrongMigrations
  module Adapters
    class AbstractAdapter
      def initialize(checker)
        @checker = checker
      end

      def min_version
        nil
      end

      def set_statement_timeout(timeout)
        # no-op by default
      end

      def check_lock_timeout
        # no-op by default
      end

      private

      def connection
        @checker.send(:connection)
      end

      def quote(value)
        connection.quote(value)
      end
    end
  end
end
```

## PostgreSQL Adapter

```ruby
# lib/strong_migrations/adapters/postgresql_adapter.rb
module StrongMigrations
  module Adapters
    class PostgreSQLAdapter < AbstractAdapter
      def min_version
        "12"
      end

      def set_statement_timeout(timeout)
        select_all("SET statement_timeout = #{timeout.to_i * 1000}")
      end

      def set_lock_timeout(timeout)
        select_all("SET lock_timeout = #{timeout.to_i * 1000}")
      end

      def check_lock_timeout
        lock_timeout = connection.select_value("SHOW lock_timeout")
        lock_timeout_sec = timeout_to_sec(lock_timeout)
        # validation logic
      end

      private

      def select_all(sql)
        connection.select_all(sql)
      end

      def timeout_to_sec(timeout)
        units = {"us" => 1e-6, "ms" => 1e-3, "s" => 1, "min" => 60}
        timeout.to_f * (units[timeout.gsub(/\d+/, "")] || 1e-3)
      end
    end
  end
end
```

## MySQL Adapter

```ruby
# lib/strong_migrations/adapters/mysql_adapter.rb
module StrongMigrations
  module Adapters
    class MySQLAdapter < AbstractAdapter
      def min_version
        "8.0"
      end

      def set_statement_timeout(timeout)
        select_all("SET max_execution_time = #{timeout.to_i * 1000}")
      end

      def check_lock_timeout
        lock_timeout = connection.select_value("SELECT @@lock_wait_timeout")
        # validation logic
      end
    end
  end
end
```

## MariaDB Adapter (MySQL variant)

```ruby
# lib/strong_migrations/adapters/mariadb_adapter.rb
module StrongMigrations
  module Adapters
    class MariaDBAdapter < MySQLAdapter
      def min_version
        "10.5"
      end

      # Override MySQL-specific behavior
      def set_statement_timeout(timeout)
        select_all("SET max_statement_time = #{timeout.to_i}")
      end
    end
  end
end
```

## Adapter Detection Pattern

Use regex matching on adapter name:

```ruby
def adapter
  @adapter ||= case connection.adapter_name
    when /postg/i
      Adapters::PostgreSQLAdapter.new(self)
    when /mysql|trilogy/i
      if connection.try(:mariadb?)
        Adapters::MariaDBAdapter.new(self)
      else
        Adapters::MySQLAdapter.new(self)
      end
    when /sqlite/i
      Adapters::SQLiteAdapter.new(self)
    else
      Adapters::AbstractAdapter.new(self)
    end
end
```

## Multi-Database Support (PgHero pattern)

```ruby
module PgHero
  class << self
    attr_accessor :databases
  end

  self.databases = {}

  def self.primary_database
    databases.values.first
  end

  def self.capture_query_stats(database: nil)
    db = database ? databases[database] : primary_database
    db.capture_query_stats
  end

  class Database
    attr_reader :id, :config

    def initialize(id, config)
      @id = id
      @config = config
    end

    def connection_model
      @connection_model ||= begin
        Class.new(ActiveRecord::Base) do
          self.abstract_class = true
        end.tap do |model|
          model.establish_connection(config)
        end
      end
    end

    def connection
      connection_model.connection
    end
  end
end
```

## Connection Switching

```ruby
def with_connection(database_name)
  db = databases[database_name.to_s]
  raise Error, "Unknown database: #{database_name}" unless db

  yield db.connection
end

# Usage
PgHero.with_connection(:replica) do |conn|
  conn.execute("SELECT * FROM users")
end
```

## SQL Dialect Handling

```ruby
def quote_column(column)
  case adapter_name
  when /postg/i
    %("#{column}")
  when /mysql/i
    "`#{column}`"
  else
    column
  end
end

def boolean_value(value)
  case adapter_name
  when /postg/i
    value ? "true" : "false"
  when /mysql/i
    value ? "1" : "0"
  else
    value.to_s
  end
end
```
